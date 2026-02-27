/// <reference types="../../worker-configuration.d.ts" />

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { stepCountIs, streamText, tool } from "ai";
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

# Your environment

You are inside a Linux sandbox container with Node.js 20 and npm pre-installed. Your project directory is /workspace/ (starts empty). You interact with it exclusively through your tools — you cannot browse the web, ask questions, or access anything outside the sandbox.

# Your tools

You have four tools. Use them thoughtfully — each call is visible to the user watching your progress.

**write_file(path, content)** — Create or overwrite a file. Paths are relative to /workspace/ (use "src/index.ts", not "/workspace/src/index.ts"). Always write the entire file — partial writes and appending are not supported. Use this to create every file the project needs: package.json, source code, config, tests.

**read_file(path)** — Read a file you've already written. Use this when you need to check what's in a file before modifying it, or to verify a write succeeded. You don't need to read files you just wrote — you already know their content.

**exec(command)** — Run a shell command with cwd=/workspace/. Returns stdout, stderr, and exit code. Use this for installing dependencies, running tests, running builds, and diagnosing problems. Commands time out after 2 minutes. Important: read the output carefully. If a command fails, understand why before retrying — don't blindly re-run.

**done(summary)** — Declare the project complete. Only call this after you have verified the project works (tests pass or the app runs). The summary should describe what was built and how to run it.

# How to build the project

Think before you write. Before creating any files, mentally plan the project structure: what modules, what entry point, what dependencies, what tests. Then:

1. **Write all files first.** Start with package.json (include every dependency the project needs). Then write every source file, config file, and test file. Get the entire codebase on disk before running anything. Running npm install on a half-written project wastes time and produces misleading errors.

2. **Install and verify.** Once every file exists, run \`npm install\`. Then run tests or a build to confirm it works. Read the output — if something fails, fix the specific file and re-run.

3. **Iterate until clean.** Build errors and test failures are normal. Diagnose each one, fix the file, and re-run. Don't move on until the project is clean.

4. **Signal completion.** Call done() with a summary of what you built.

# What good output looks like

- Every feature from the spec is implemented, not stubbed.
- The project has a clear entry point and can be run with a standard command (e.g., \`npm start\` or \`node src/index.js\`).
- Dependencies are real npm packages, correctly versioned in package.json.
- Code is clean and production-quality. No TODOs, no placeholder comments, no dummy data.
- If the platform suggests tests (API, CLI, library), include meaningful tests that actually run.
- File paths are sensible and follow conventions for the platform (e.g., src/ for source, tests/ or __tests__/ for tests).`;

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
	const tools = createStreamingTools(sandbox, files, onFileWrite);

	return streamText({
		model: workersai(MODEL),
		system: BUILD_SYSTEM_PROMPT,
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		stopWhen: stepCountIs(MAX_STEPS),
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
	const tools = createStreamingTools(sandbox, files, onFileWrite);

	return streamText({
		model: workersai(MODEL),
		system: buildFeedbackPrompt(feedback),
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		stopWhen: stepCountIs(MAX_STEPS),
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
