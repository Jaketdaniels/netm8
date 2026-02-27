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

// ── Hermes tool call middleware ──────────────────────────────────────────
// Hermes 2 Pro emits tool calls as <tool_call> text instead of structured
// responses. This middleware intercepts both doGenerate and doStream,
// parses the text, and converts to proper tool-call content parts.

function parseHermesToolCalls(text: string): Array<{ toolName: string; input: string }> | null {
	const matches = text.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g);
	const calls: Array<{ toolName: string; input: string }> = [];

	for (const match of matches) {
		const raw = match[1].trim();

		// 1. Try direct JSON.parse (Hermes typically outputs valid JSON)
		try {
			const parsed = JSON.parse(raw);
			const name = parsed.name;
			const args = parsed.arguments ?? parsed.parameters ?? {};
			if (name) {
				calls.push({
					toolName: name,
					input: typeof args === "string" ? args : JSON.stringify(args),
				});
				continue;
			}
		} catch {
			// fall through to regex extraction
		}

		// 2. Extract tool name via regex (handles single/double quotes, malformed JSON)
		const nameMatch = raw.match(/["']?name["']?\s*:\s*["']([^"']+)["']/);
		if (!nameMatch) continue;
		const toolName = nameMatch[1];

		// 3. Extract arguments block
		const argsMatch = raw.match(/["']?(?:arguments|parameters)["']?\s*:\s*(\{[\s\S]*)/);
		if (!argsMatch) {
			calls.push({ toolName, input: "{}" });
			continue;
		}

		// 4. Balance braces (handle both single and double quoted strings)
		const argsRaw = argsMatch[1];
		let depth = 0;
		let inString = false;
		let stringChar = "";
		let escaped = false;
		let endIdx = -1;
		for (let i = 0; i < argsRaw.length; i++) {
			const ch = argsRaw[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if ((ch === '"' || ch === "'") && !inString) {
				inString = true;
				stringChar = ch;
				continue;
			}
			if (ch === stringChar && inString) {
				inString = false;
				continue;
			}
			if (inString) continue;
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					endIdx = i;
					break;
				}
			}
		}
		const argsStr = endIdx >= 0 ? argsRaw.slice(0, endIdx + 1) : argsRaw;

		// 5. Try parsing the extracted args
		try {
			const args = JSON.parse(argsStr);
			calls.push({ toolName, input: JSON.stringify(args) });
		} catch {
			// Last resort: Python-style single-quote fix
			try {
				const fixed = argsStr.replace(/'/g, '"');
				const args = JSON.parse(fixed);
				calls.push({ toolName, input: JSON.stringify(args) });
			} catch {
				console.error("[hermes] Failed to parse tool call args for:", toolName);
			}
		}
	}

	return calls.length > 0 ? calls : null;
}

function processHermesResult(result: any) {
	const hasStructuredToolCalls = result.content?.some(
		(p: { type: string }) => p.type === "tool-call",
	);
	if (hasStructuredToolCalls) return result;

	const textPart = result.content?.find(
		(p: { type: string; text?: string }) => p.type === "text" && p.text?.includes("<tool_call>"),
	) as { type: string; text: string } | undefined;

	if (!textPart) return result;

	const parsed = parseHermesToolCalls(textPart.text);
	if (!parsed) return result;

	result.content = result.content.filter((p: { type: string }) => p.type !== "text");
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
}

function hermesToolMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v3",

		// Intercepts generateText — parses <tool_call> XML from Hermes text
		wrapGenerate: async ({ doGenerate }) => {
			const result = await doGenerate();
			return processHermesResult(result);
		},

		// Intercepts streamText — delegates to doGenerate then simulates a stream.
		// CRITICAL: wrapStream's doGenerate() bypasses wrapGenerate (they're separate
		// code paths in the AI SDK), so we must apply processHermesResult here too.
		wrapStream: async ({ doGenerate }) => {
			const result = processHermesResult(await doGenerate());

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
									controller.enqueue({ type: "text-delta", id: String(id), delta: part.text });
									controller.enqueue({ type: "text-end", id: String(id) });
									id++;
								}
								break;
							}
							default: {
								// tool-call parts pass through directly
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
		middleware: hermesToolMiddleware(),
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
