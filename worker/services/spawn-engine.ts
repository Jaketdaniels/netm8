/// <reference types="../../worker-configuration.d.ts" />

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { LanguageModelMiddleware } from "ai";
import { hasToolCall, stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { type SpecResult, SpecResultSchema } from "../../src/shared/schemas";

// ── Model ───────────────────────────────────────────────────────────────

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const MAX_STEPS = 20;

// ── Spec (one-shot, unchanged) ──────────────────────────────────────────

function extractResponse(result: unknown): string | object {
	if (result instanceof ReadableStream) {
		throw new Error("Unexpected stream response — use non-streaming mode");
	}
	const response = (result as { response?: string | object | null }).response;
	if (!response) throw new Error("Workers AI returned an empty response");
	return response;
}

export async function extractSpec(ai: Ai, prompt: string): Promise<SpecResult> {
	const system = `You are a software architect. Given a natural language description, extract a structured specification as JSON.
Output a JSON object with exactly these fields:
- "name": short kebab-case identifier (e.g. "todo-app")
- "description": single sentence describing the project
- "platform": one of "ios", "android", "web", "desktop", "cli", "api"
- "features": array of 3-8 distinct feature strings
- "summary": 2-3 sentences addressed to the user explaining what you understood from their request, what you'll build, and the key features. Write conversationally (e.g. "I'll build a REST API that…"). End by telling them to review the plan and start building, or describe any changes.
Output ONLY valid JSON, no extra text.`;

	const result = await ai.run(MODEL, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: prompt },
		],
		max_tokens: 1024,
	});

	const raw = extractResponse(result);
	const text = typeof raw === "string" ? raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim() : raw;
	const json = typeof text === "string" ? JSON.parse(text) : text;
	const parsed = SpecResultSchema.safeParse(json);

	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		throw new Error(`AI response failed validation: ${issues}`);
	}

	return parsed.data;
}

// ── System Prompts ──────────────────────────────────────────────────────

const BUILD_SYSTEM_PROMPT = `You are a senior software engineer. You build complete projects by writing files.

You have these tools:
- write_file: Write a file (path relative to /workspace/).
- read_file: Read a file from the workspace.
- exec: Execute a shell command in /workspace/.
- done: Signal completion.

npm install runs automatically after you finish — do NOT try to run it yourself.

Workflow:
1. Call write_file for package.json (include all dependencies needed).
2. Call write_file for EACH source file (one file per call).
3. Use read_file and exec as needed to verify your work.
4. When ALL files are written, call done with a summary.

Before each tool call, briefly state what you're about to do and why (1 sentence).

Rules:
- Call one tool per response.
- Implement every feature from the spec. No stubs, no placeholders.
- Paths are relative to /workspace/ (e.g. "src/index.ts", "package.json").`;

function buildFeedbackPrompt(feedback: string): string {
	return `${BUILD_SYSTEM_PROMPT}

This is an existing project — the user's files are already in /workspace/. Apply the requested changes (do NOT start from scratch). Read existing files if needed, make changes, verify with exec, then call done().

User feedback: ${feedback}`;
}

export function specToPrompt(spec: SpecResult): string {
	return `Build this project:
Name: ${spec.name}
Description: ${spec.description}
Platform: ${spec.platform}
Features: ${spec.features.join(", ")}`;
}

// ── Sandbox tools (streaming) ───────────────────────────────────────────

function writeFileTool(
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	onFileWrite: (path: string, content: string) => void,
) {
	return tool({
		description: "Write or overwrite a file in the workspace. Path is relative to /workspace/.",
		inputSchema: z.object({
			path: z.string().describe("Relative file path (e.g. src/index.ts)"),
			content: z.string().describe("Full file content"),
		}),
		execute: async ({ path, content }) => {
			console.log(`[tool:write_file] Starting: ${path} (${content.length} bytes)`);
			try {
				await sandbox.writeFile(`/workspace/${path}`, content);
			} catch (err) {
				console.error("[tool:write_file] FAILED:", err instanceof Error ? err.message : err);
				throw err;
			}
			files.set(path, content);
			onFileWrite(path, content);
			console.log(`[tool:write_file] Done: ${path}`);
			return `Wrote ${path} (${content.length} bytes)`;
		},
	});
}

function doneTool() {
	return tool({
		description: "Signal that the project is complete. Call this after writing ALL files.",
		inputSchema: z.object({
			summary: z.string().describe("Brief summary of what was built"),
		}),
		execute: async ({ summary }) => {
			console.log("[tool:done] Build complete");
			return summary;
		},
	});
}

// Build tools: full set for initial build.
// npm install runs automatically after the model finishes.
function createBuildTools(
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	onFileWrite: (path: string, content: string) => void,
) {
	return {
		write_file: writeFileTool(sandbox, files, onFileWrite),

		read_file: tool({
			description: "Read the contents of a file in the workspace.",
			inputSchema: z.object({
				path: z.string().describe("Relative file path to read"),
			}),
			execute: async ({ path }) => {
				console.log(`[tool:read_file] Reading: ${path}`);
				const file = await sandbox.readFile(`/workspace/${path}`);
				return file.content;
			},
		}),

		exec: tool({
			description:
				"Execute a shell command in the workspace. Use for npm install, npm test, build commands, etc.",
			inputSchema: z.object({
				command: z.string().describe("Shell command to execute"),
			}),
			execute: async ({ command }) => {
				console.log(`[tool:exec] Running: ${command}`);
				const result = await sandbox.exec(command, {
					cwd: "/workspace",
					timeout: 120_000,
				});
				const output = JSON.stringify({
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
					success: result.exitCode === 0,
				});
				console.log(`[tool:exec] Exit code: ${result.exitCode}, output: ${output.slice(0, 500)}`);
				return output;
			},
		}),

		done: doneTool(),
	};
}

// Feedback tools: full set including exec and read_file for iterating.
function createFeedbackTools(
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	onFileWrite: (path: string, content: string) => void,
) {
	return {
		write_file: writeFileTool(sandbox, files, onFileWrite),

		read_file: tool({
			description: "Read the contents of a file in the workspace.",
			inputSchema: z.object({
				path: z.string().describe("Relative file path to read"),
			}),
			execute: async ({ path }) => {
				console.log(`[tool:read_file] Reading: ${path}`);
				const file = await sandbox.readFile(`/workspace/${path}`);
				return file.content;
			},
		}),

		exec: tool({
			description:
				"Execute a shell command in the workspace. Use for npm install, npm test, build commands, etc.",
			inputSchema: z.object({
				command: z.string().describe("Shell command to execute"),
			}),
			execute: async ({ command }) => {
				console.log(`[tool:exec] Running: ${command}`);
				const result = await sandbox.exec(command, {
					cwd: "/workspace",
					timeout: 120_000,
				});
				const output = JSON.stringify({
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
					success: result.exitCode === 0,
				});
				console.log(`[tool:exec] Exit code: ${result.exitCode}, output: ${output.slice(0, 500)}`);
				return output;
			},
		}),

		done: doneTool(),
	};
}

// ── Tool-call middleware ─────────────────────────────────────────────────
// Workers AI streaming does not reliably return structured tool_calls for
// Llama 3.3 — the model outputs function-call JSON as plain text instead.
// This middleware routes through doGenerate (non-streaming) where tool calls
// are more reliable, then falls back to parsing text-based function calls
// when the API still returns them as text.

function parseTextToolCalls(text: string): Array<{ toolName: string; input: string }> | null {
	const calls: Array<{ toolName: string; input: string }> = [];

	// Match JSON objects with "name" and either "parameters" or "arguments"
	// Handles both {"type":"function","name":"exec","parameters":{...}} and {"name":"exec","arguments":{...}}
	const regex =
		/\{[^{}]*"(?:name)":\s*"([^"]+)"[^{}]*"(?:parameters|arguments)":\s*(\{[\s\S]*?\})[^{}]*\}/g;
	for (const match of text.matchAll(regex)) {
		const toolName = match[1];
		const argsRaw = match[2];
		try {
			const args = JSON.parse(argsRaw);
			calls.push({ toolName, input: JSON.stringify(args) });
		} catch {
			// Try broader extraction: find the full JSON object and parse it
			try {
				const fullObj = JSON.parse(match[0]);
				const name = fullObj.name;
				const params = fullObj.parameters ?? fullObj.arguments ?? {};
				if (name) {
					calls.push({
						toolName: name,
						input: typeof params === "string" ? params : JSON.stringify(params),
					});
				}
			} catch {
				console.error("[tool-middleware] Failed to parse tool call for:", toolName);
			}
		}
	}

	return calls.length > 0 ? calls : null;
}

function toolCallMiddleware(kv?: KVNamespace): LanguageModelMiddleware {
	return {
		specificationVersion: "v3",

		// Non-streaming: check for text-based tool calls if no structured ones
		wrapGenerate: async ({ doGenerate }) => {
			const result = await doGenerate();

			const hasStructured = result.content?.some((p: { type: string }) => p.type === "tool-call");
			if (hasStructured) {
				// Fix finishReason: Workers AI returns "stop" even with tool calls
				if (result.finishReason?.unified === "stop") {
					result.finishReason = { ...result.finishReason, unified: "tool-calls" };
				}
				return result;
			}

			// Check text parts for function-call JSON
			const textPart = result.content?.find(
				(p: { type: string; text?: string }) =>
					p.type === "text" && (p.text?.includes('"name"') ?? false),
			) as { type: string; text: string } | undefined;

			if (!textPart) return result;

			const parsed = parseTextToolCalls(textPart.text);
			if (!parsed) return result;

			// Strip tool-call JSON from text, keep any remaining text
			let cleanText = textPart.text;
			for (const call of parsed) {
				// Remove the matched JSON object from text
				const pattern = new RegExp(`\\{[^{}]*"name":\\s*"${call.toolName}"[\\s\\S]*?\\}\\s*\\}`);
				cleanText = cleanText.replace(pattern, "").trim();
			}

			result.content = result.content.filter((p: { type: string }) => p.type !== "text");
			if (cleanText) {
				result.content.unshift({ type: "text" as const, text: cleanText });
			}

			for (const call of parsed) {
				result.content.push({
					type: "tool-call" as const,
					toolCallId: `tc_${crypto.randomUUID().slice(0, 8)}`,
					toolName: call.toolName,
					input: call.input,
				});
			}

			if (result.finishReason?.unified === "stop") {
				result.finishReason = { ...result.finishReason, unified: "tool-calls" };
			}

			return result;
		},

		// Streaming: delegate to doGenerate for reliable tool-call detection,
		// then simulate a stream from the result.
		wrapStream: async ({ doGenerate, params }) => {
			// Log input messages to verify tool results flow back
			const inputMessages = (params as { prompt?: unknown[] }).prompt ?? [];
			const messageSummary = (inputMessages as { role: string; content: unknown }[]).map((m) => {
				if (m.role === "tool") {
					const parts = Array.isArray(m.content) ? m.content : [];
					return `tool(${parts.length} results)`;
				}
				if (m.role === "assistant") {
					const parts = Array.isArray(m.content) ? m.content : [];
					const types = parts.map((p: { type: string }) => p.type);
					return `assistant[${types.join(",")}]`;
				}
				return m.role;
			});
			console.log(`[middleware:wrapStream] input: ${messageSummary.join(" → ")}`);

			const result = await doGenerate();

			// Diagnostic logging
			const contentTypes = result.content?.map((p: { type: string }) => p.type) ?? [];
			const toolCallParts =
				result.content?.filter((p: { type: string }) => p.type === "tool-call") ?? [];

			const logEntry = {
				timestamp: new Date().toISOString(),
				phase: "after-doGenerate",
				inputMessageCount: inputMessages.length,
				inputMessageRoles: messageSummary,
				contentTypes,
				finishReason: result.finishReason,
				toolCallCount: toolCallParts.length,
				toolCallNames: toolCallParts.map((p: unknown) => (p as { toolName?: string }).toolName),
				rawContent: JSON.stringify(result.content).slice(0, 2000),
			};
			console.log("[middleware:wrapStream]", JSON.stringify(logEntry));
			if (kv) {
				try {
					const prev = await kv.get("debug:middleware-log");
					const logs = prev ? JSON.parse(prev) : [];
					logs.push(logEntry);
					await kv.put("debug:middleware-log", JSON.stringify(logs.slice(-10)), {
						expirationTtl: 300,
					});
				} catch {
					// Best-effort
				}
			}

			// Apply the same text-based tool call extraction
			const hasStructured = result.content?.some((p: { type: string }) => p.type === "tool-call");

			if (!hasStructured) {
				const textPart = result.content?.find(
					(p: { type: string; text?: string }) =>
						p.type === "text" && (p.text?.includes('"name"') ?? false),
				) as { type: string; text: string } | undefined;

				if (textPart) {
					const parsed = parseTextToolCalls(textPart.text);
					if (parsed) {
						let cleanText = textPart.text;
						for (const call of parsed) {
							const pattern = new RegExp(
								`\\{[^{}]*"name":\\s*"${call.toolName}"[\\s\\S]*?\\}\\s*\\}`,
							);
							cleanText = cleanText.replace(pattern, "").trim();
						}

						result.content = result.content.filter((p: { type: string }) => p.type !== "text");
						if (cleanText) {
							result.content.unshift({ type: "text" as const, text: cleanText });
						}

						for (const call of parsed) {
							result.content.push({
								type: "tool-call" as const,
								toolCallId: `tc_${crypto.randomUUID().slice(0, 8)}`,
								toolName: call.toolName,
								input: call.input,
							});
						}

						if (result.finishReason?.unified === "stop") {
							result.finishReason = {
								...result.finishReason,
								unified: "tool-calls",
							};
						}
					}
				}
			}

			// Fix finishReason: Workers AI returns "stop" even when tool calls are present.
			// streamText's multi-step loop only continues when finishReason is "tool-calls".
			const hasAnyToolCalls = result.content?.some((p: { type: string }) => p.type === "tool-call");
			if (hasAnyToolCalls && result.finishReason?.unified === "stop") {
				result.finishReason = { ...result.finishReason, unified: "tool-calls" };
			}

			// Log final content after extraction
			const finalTypes = result.content?.map((p: { type: string }) => p.type) ?? [];
			const toolCalls =
				result.content?.filter((p: { type: string }) => p.type === "tool-call") ?? [];
			console.log(
				`[middleware:wrapStream] after extraction: [${finalTypes.join(", ")}], tool calls: ${toolCalls.length}, finishReason: ${result.finishReason?.unified}`,
			);

			// Simulate a stream from the generate result.
			// IMPORTANT: Content parts use { input } but stream parts use { args }.
			// Also stream tool-call parts require { toolCallType: "function" }.
			let id = 0;
			const simulatedStream = new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "stream-start", warnings: result.warnings });
					if (result.response) {
						controller.enqueue({ type: "response-metadata", ...result.response });
					}

					for (const part of result.content) {
						switch (part.type) {
							case "text": {
								if (part.text.length > 0) {
									controller.enqueue({ type: "text-start", id: String(id) });
									controller.enqueue({
										type: "text-delta",
										id: String(id),
										delta: part.text,
									});
									controller.enqueue({ type: "text-end", id: String(id) });
									id++;
								}
								break;
							}
							case "tool-call": {
								// Convert content part format → stream part format
								const tc = part as {
									toolCallId: string;
									toolName: string;
									input: unknown;
									toolCallType?: string;
								};
								controller.enqueue({
									type: "tool-call" as const,
									toolCallType: "function" as const,
									toolCallId: tc.toolCallId,
									toolName: tc.toolName,
									args: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
								});
								break;
							}
							default: {
								controller.enqueue(part);
								break;
							}
						}
					}

					controller.enqueue({
						type: "finish",
						finishReason: result.finishReason,
						usage: result.usage,
						providerMetadata: result.providerMetadata,
					});
					controller.close();
				},
			});

			return {
				stream: simulatedStream,
				request: result.request,
				response: result.response,
			};
		},
	};
}

function createModel(env: { AI: Ai; CACHE?: KVNamespace }) {
	const workersai = createWorkersAI({ binding: env.AI });
	return wrapLanguageModel({
		model: workersai(MODEL),
		middleware: toolCallMiddleware(env.CACHE),
	});
}

// ── Streaming build functions ───────────────────────────────────────────

export function buildProjectStream(
	env: { AI: Ai; CACHE?: KVNamespace },
	spec: SpecResult,
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	onFileWrite: (path: string, content: string) => void,
	onFinish?: (event: { text: string }) => void | PromiseLike<void>,
	onReasoningUpdate?: (text: string) => void,
) {
	const model = createModel(env);
	const tools = createBuildTools(sandbox, files, onFileWrite);

	console.log("[buildProjectStream] Starting build for:", spec.name);
	return streamText({
		model,
		system: BUILD_SYSTEM_PROMPT,
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		toolChoice: "required",
		maxOutputTokens: 4096,
		stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("done")],
		onStepFinish: (event) => {
			console.log(
				`[buildProjectStream] Step finished: finishReason=${event.finishReason}, toolCalls=${event.toolCalls?.length ?? 0}, text=${event.text?.slice(0, 200) ?? "(none)"}`,
			);
			if (event.text?.trim()) {
				onReasoningUpdate?.(event.text.trim());
			}
		},
		onFinish: async (event) => {
			// Auto-run npm install if package.json was written
			if (files.has("package.json")) {
				console.log("[buildProjectStream] Running npm install...");
				try {
					const result = await sandbox.exec("npm install", { cwd: "/workspace", timeout: 120_000 });
					console.log(`[buildProjectStream] npm install exit: ${result.exitCode}`);
				} catch (err) {
					console.error(
						"[buildProjectStream] npm install failed:",
						err instanceof Error ? err.message : err,
					);
				}
			}
			onFinish?.(event);
		},
	});
}

export function continueProjectStream(
	env: { AI: Ai; CACHE?: KVNamespace },
	spec: SpecResult,
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	feedback: string,
	onFileWrite: (path: string, content: string) => void,
	onFinish?: (event: { text: string }) => void | PromiseLike<void>,
	onReasoningUpdate?: (text: string) => void,
) {
	const model = createModel(env);
	const tools = createFeedbackTools(sandbox, files, onFileWrite);

	return streamText({
		model,
		system: buildFeedbackPrompt(feedback),
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		toolChoice: "required",
		maxOutputTokens: 4096,
		stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("done")],
		onStepFinish: (event) => {
			if (event.text?.trim()) {
				onReasoningUpdate?.(event.text.trim());
			}
		},
		onFinish,
	});
}

// ── Sandbox lifecycle helpers ───────────────────────────────────────────

export function createSandbox(env: { Sandbox: DurableObjectNamespace<Sandbox> }) {
	const sandboxId = crypto.randomUUID().slice(0, 8);
	return getSandbox(env.Sandbox, `spawn-${sandboxId}`);
}

export async function seedSandbox(
	sandbox: ReturnType<typeof getSandbox>,
	existingFiles: Map<string, string>,
) {
	for (const [path, content] of existingFiles) {
		await sandbox.writeFile(`/workspace/${path}`, content);
	}
}
