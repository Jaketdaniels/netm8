/// <reference types="../../worker-configuration.d.ts" />

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { LanguageModelMiddleware } from "ai";
import { hasToolCall, stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { type SpecResult, SpecResultSchema } from "../../src/shared/schemas";

// ── Model ───────────────────────────────────────────────────────────────

const MODEL = "@hf/nousresearch/hermes-2-pro-mistral-7b" as const;
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
Output ONLY valid JSON, no extra text.`;

	const result = await ai.run(MODEL, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: prompt },
		],
		max_tokens: 1024,
	});

	const raw = extractResponse(result);
	const json = typeof raw === "string" ? JSON.parse(raw) : raw;
	const parsed = SpecResultSchema.safeParse(json);

	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		throw new Error(`AI response failed validation: ${issues}`);
	}

	return parsed.data;
}

// ── System Prompts ──────────────────────────────────────────────────────

const BUILD_SYSTEM_PROMPT = `You are a senior software engineer who builds complete, working projects from specifications.

You will receive a project spec with a name, description, platform, and feature list. Your job is to turn that spec into a real, runnable project — not a skeleton or boilerplate, but actual working software that implements every feature described.

# CRITICAL RULES

1. You MUST call exactly ONE tool per response. Never respond with text only — always call a tool.
2. Call write_file for EACH file — one file per tool call, one tool call per response.
3. After writing ALL files, call exec to install and verify.
4. When the project is complete and verified, call done.
5. NEVER include explanatory text alongside your tool call. Just call the tool.

# Your environment

You are inside a Linux sandbox container with Node.js 20 and npm pre-installed. Your project directory is /workspace/ (starts empty). You interact with it exclusively through your tools.

# Your tools

**write_file(path, content)** — Create or overwrite a file. Paths are relative to /workspace/ (e.g. "src/index.ts"). Always write the entire file content.

**read_file(path)** — Read a file you've already written.

**exec(command)** — Run a shell command with cwd=/workspace/. Returns stdout, stderr, and exit code. Use for npm install, running tests, builds, etc.

**done(summary)** — Signal project completion. Only call after verifying the project works.

# Workflow

1. Call write_file for package.json with ALL dependencies.
2. Call write_file for each source file, one at a time.
3. Call write_file for each test/config file, one at a time.
4. Call exec to run npm install.
5. Call exec to run tests or verify the build.
6. Fix any errors by calling write_file then exec again.
7. Call done with a summary.

# Quality

- Implement every feature from the spec — no stubs.
- Clear entry point, real dependencies, clean code.
- Include tests for APIs, CLIs, and libraries.`;

function buildFeedbackPrompt(feedback: string): string {
	return `${BUILD_SYSTEM_PROMPT}

# Context

This is an existing project. The user's files are already in the sandbox at /workspace/. You are making changes based on their feedback — do NOT start from scratch. Read existing files if needed, apply the requested changes, verify with exec, and call done().

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
// responses. This middleware intercepts doGenerate, parses the text, and
// converts to proper tool-call content parts.

function parseHermesToolCalls(text: string): Array<{ toolName: string; input: string }> | null {
	const matches = text.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g);
	const calls: Array<{ toolName: string; input: string }> = [];

	for (const match of matches) {
		const raw = match[1].trim();
		// Hermes sometimes outputs Python-style single quotes — fix to valid JSON
		const fixed = raw.replace(/'/g, '"');
		try {
			const parsed = JSON.parse(fixed);
			const name = parsed.name;
			const args = parsed.arguments ?? parsed.parameters ?? {};
			if (name) {
				calls.push({
					toolName: name,
					input: typeof args === "string" ? args : JSON.stringify(args),
				});
			}
		} catch {
			// Not parseable — skip
		}
	}

	return calls.length > 0 ? calls : null;
}

function hermesToolMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v3",

		// Intercepts generateText — parses <tool_call> XML from Hermes text
		wrapGenerate: async ({ doGenerate }) => {
			const result = await doGenerate();

			const hasStructuredToolCalls = result.content?.some(
				(p: { type: string }) => p.type === "tool-call",
			);
			if (hasStructuredToolCalls) return result;

			const textPart = result.content?.find(
				(p: { type: string; text?: string }) =>
					p.type === "text" && p.text?.includes("<tool_call>"),
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
		},

		// Intercepts streamText — delegates to doGenerate (which routes through
		// wrapGenerate above) then simulates a stream from the parsed result.
		// This is necessary because Workers AI doesn't truly stream for Hermes,
		// and the provider's doStream bypasses middleware wrapGenerate.
		wrapStream: async ({ doGenerate }) => {
			const result = await doGenerate();

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
		toolChoice: "required",
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
		toolChoice: "required",
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
