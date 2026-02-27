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

const BUILD_SYSTEM_PROMPT = `You are a senior software engineer. You build complete, working projects inside a Linux sandbox with Node.js 20 and npm. The project directory is /workspace/ (starts empty).

You have tools to write files, read files, run shell commands, and signal completion. Use them — do not explain what you would do, actually do it by calling the tools.

Workflow:
1. write_file for package.json first (include all dependencies).
2. write_file for each source file (one per call).
3. exec to run npm install.
4. exec to run tests or verify the build.
5. If errors, fix with write_file then exec again.
6. When everything works, call done with a summary.

Rules:
- Call one tool per response. Do not include explanatory text — just call the tool.
- Implement every feature from the spec. No stubs, no placeholders.
- Paths are relative to /workspace/ (e.g. "src/index.ts").`;

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

function createStreamingTools(
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	onFileWrite: (path: string, content: string) => void,
) {
	return {
		write_file: tool({
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
		}),

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
				console.log(`[tool:exec] Exit code: ${result.exitCode}`);
				return JSON.stringify({
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
					success: result.exitCode === 0,
				});
			},
		}),

		done: tool({
			description:
				"Signal that the project is complete. Call this when all files are written, tests pass, and the project is ready.",
			inputSchema: z.object({
				summary: z.string().describe("Brief summary of what was built"),
			}),
			execute: async ({ summary }) => {
				console.log("[tool:done] Build complete");
				return summary;
			},
		}),
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

function toolCallMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v3",

		// Non-streaming: check for text-based tool calls if no structured ones
		wrapGenerate: async ({ doGenerate }) => {
			const result = await doGenerate();

			const hasStructured = result.content?.some((p: { type: string }) => p.type === "tool-call");
			if (hasStructured) return result;

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
		wrapStream: async ({ doGenerate }) => {
			const result = await doGenerate();

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

function createModel(env: { AI: Ai }) {
	const workersai = createWorkersAI({ binding: env.AI });
	return wrapLanguageModel({
		model: workersai(MODEL),
		middleware: toolCallMiddleware(),
	});
}

// ── Streaming build functions ───────────────────────────────────────────

export function buildProjectStream(
	env: { AI: Ai },
	spec: SpecResult,
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	onFileWrite: (path: string, content: string) => void,
	onFinish?: (event: { text: string }) => void | PromiseLike<void>,
) {
	const model = createModel(env);
	const tools = createStreamingTools(sandbox, files, onFileWrite);

	return streamText({
		model,
		system: BUILD_SYSTEM_PROMPT,
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		toolChoice: "auto",
		maxOutputTokens: 4096,
		stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("done")],
		onFinish,
	});
}

export function continueProjectStream(
	env: { AI: Ai },
	spec: SpecResult,
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	feedback: string,
	onFileWrite: (path: string, content: string) => void,
	onFinish?: (event: { text: string }) => void | PromiseLike<void>,
) {
	const model = createModel(env);
	const tools = createStreamingTools(sandbox, files, onFileWrite);

	return streamText({
		model,
		system: buildFeedbackPrompt(feedback),
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		toolChoice: "auto",
		maxOutputTokens: 4096,
		stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("done")],
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
