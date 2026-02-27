/// <reference types="../../worker-configuration.d.ts" />

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import {
	hasToolCall,
	NoSuchToolError,
	simulateStreamingMiddleware,
	stepCountIs,
	streamText,
	tool,
	wrapLanguageModel,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { SPEC_JSON_SCHEMA, type SpecResult, SpecResultSchema } from "../../src/shared/schemas";

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
	const system = `You are a software architect. Given a natural language description, extract a structured specification.
Rules:
- "name" must be a short kebab-case identifier
- "description" must be a single sentence
- "platform" must be one of: ios, android, web, desktop, cli, api
- "features" must list 3-8 distinct features`;

	const result = await ai.run(MODEL, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: prompt },
		],
		max_tokens: 4096,
		response_format: {
			type: "json_schema",
			json_schema: SPEC_JSON_SCHEMA,
		},
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
				await sandbox.writeFile(`/workspace/${path}`, content);
				files.set(path, content);
				onFileWrite(path, content);
				return `Wrote ${path} (${content.length} bytes)`;
			},
		}),

		read_file: tool({
			description: "Read the contents of a file in the workspace.",
			inputSchema: z.object({
				path: z.string().describe("Relative file path to read"),
			}),
			execute: async ({ path }) => {
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
				const result = await sandbox.exec(command, {
					cwd: "/workspace",
					timeout: 120_000,
				});
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
				return summary;
			},
		}),
	};
}

// ── Tool call repair ────────────────────────────────────────────────────
// Workers AI + Llama 3.3 sometimes returns tool calls with undefined names
// when using tool_choice:"any". This repair function handles those cases.

async function repairToolCall({
	toolCall,
	error,
}: {
	toolCall: { toolName: string; toolCallId: string; input: string };
	error: unknown;
}) {
	// Only handle NoSuchToolError (undefined/unknown tool names)
	if (!NoSuchToolError.isInstance(error)) return null;

	// Try to infer tool from input shape
	let parsed: Record<string, unknown> = {};
	try {
		parsed = typeof toolCall.input === "string" ? JSON.parse(toolCall.input) : {};
	} catch {
		return null;
	}

	let toolName: string | null = null;
	if ("path" in parsed && "content" in parsed) {
		toolName = "write_file";
	} else if ("path" in parsed && !("content" in parsed)) {
		toolName = "read_file";
	} else if ("command" in parsed) {
		toolName = "exec";
	} else if ("summary" in parsed) {
		toolName = "done";
	}

	if (!toolName) return null;

	return {
		type: "tool-call" as const,
		toolCallId: toolCall.toolCallId,
		toolName,
		input: toolCall.input,
	};
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
	const workersai = createWorkersAI({ binding: env.AI });
	// Workers AI streaming doesn't return structured tool_calls for Llama 3.3 —
	// simulateStreamingMiddleware forces the non-streaming path (doGenerate)
	// where tool calling works, then simulates the stream for the UI.
	const model = wrapLanguageModel({
		model: workersai(MODEL),
		middleware: simulateStreamingMiddleware(),
	});
	const tools = createStreamingTools(sandbox, files, onFileWrite);

	return streamText({
		model,
		system: BUILD_SYSTEM_PROMPT,
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		// Don't force toolChoice:"required" — Workers AI returns malformed tool
		// calls (undefined names) with tool_choice:"any". The system prompt
		// instructs the model to always call exactly one tool per response.
		stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("done")],
		experimental_repairToolCall: repairToolCall,
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
	const workersai = createWorkersAI({ binding: env.AI });
	const model = wrapLanguageModel({
		model: workersai(MODEL),
		middleware: simulateStreamingMiddleware(),
	});
	const tools = createStreamingTools(sandbox, files, onFileWrite);

	return streamText({
		model,
		system: buildFeedbackPrompt(feedback),
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		stopWhen: [stepCountIs(MAX_STEPS), hasToolCall("done")],
		experimental_repairToolCall: repairToolCall,
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
