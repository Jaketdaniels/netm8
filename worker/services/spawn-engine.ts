/// <reference types="../../worker-configuration.d.ts" />

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { generateText, stepCountIs, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
	type AgentStep,
	SPEC_JSON_SCHEMA,
	type SpecResult,
	SpecResultSchema,
} from "../../src/shared/schemas";

// ── Model ───────────────────────────────────────────────────────────────

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const MAX_STEPS = 20;

// ── Types ───────────────────────────────────────────────────────────────

export type OnStepFn = (step: AgentStep) => void;

export interface BuildResult {
	files: Map<string, string>;
	buildLog: string;
}

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

const BUILD_SYSTEM_PROMPT = `You are a software engineer building a project inside a sandbox container.
You have access to tools that operate on a real filesystem at /workspace/.

Tools available:
- write_file(path, content): Write or overwrite a file. Paths are relative to /workspace/.
- read_file(path): Read the contents of a file.
- exec(command): Execute a shell command. Commands run with cwd=/workspace/.
  Use this to run npm install, npm test, build commands, etc.
- done(summary): Signal that the project is complete.

Workflow:
1. Scaffold the project: write package.json, config files, source files.
2. Run \`npm install\` to install dependencies and verify no errors.
3. Write application code, tests, and configuration.
4. Run \`npm test\` (if tests exist) to verify correctness.
5. Fix any errors from build or test output.
6. Call done() with a summary when the project is fully functional.

Rules:
- Write complete, working code. Every file must be production-quality.
- File paths are relative (e.g. "src/index.ts", not "/workspace/src/index.ts").
- After writing files, run exec to verify they compile/work.
- Read exec output carefully. If a command fails, fix the issue and retry.
- Do not fabricate test results. Run real tests and fix failures.
- Include a test script in package.json when appropriate.`;

function buildFeedbackPrompt(feedback: string): string {
	return `${BUILD_SYSTEM_PROMPT}

The user has provided feedback on the existing project.
Current files are already in the sandbox at /workspace/.
Review the feedback, make the requested changes using your tools,
then verify with exec before calling done().

User feedback: ${feedback}`;
}

function specToPrompt(spec: SpecResult): string {
	return `Build this project:
Name: ${spec.name}
Description: ${spec.description}
Platform: ${spec.platform}
Features: ${spec.features.join(", ")}`;
}

// ── Helper: create step ─────────────────────────────────────────────────

function makeStep(partial: Omit<AgentStep, "id" | "timestamp">): AgentStep {
	return {
		id: crypto.randomUUID(),
		timestamp: new Date().toISOString(),
		...partial,
	};
}

// ── Tool-calling build loop ─────────────────────────────────────────────

function createSandboxTools(
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	logLines: string[],
	onStep: OnStepFn,
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
				onStep(
					makeStep({
						type: "tool_result",
						toolName: "write_file",
						toolArgs: { path, content },
						result: `Wrote ${path} (${content.length} bytes)`,
					}),
				);
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
				onStep(
					makeStep({
						type: "tool_result",
						toolName: "read_file",
						toolArgs: { path },
						result: `Read ${path}`,
					}),
				);
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
				const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
				logLines.push(`$ ${command}\n${output}`);
				onStep(
					makeStep({
						type: "tool_result",
						toolName: "exec",
						toolArgs: { command },
						result: JSON.stringify({
							stdout: result.stdout,
							stderr: result.stderr,
							exitCode: result.exitCode,
						}),
					}),
				);
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
				onStep(
					makeStep({
						type: "tool_result",
						toolName: "done",
						toolArgs: { summary },
						result: summary,
					}),
				);
				return summary;
			},
		}),
	};
}

export async function buildProject(
	env: { AI: Ai; Sandbox: DurableObjectNamespace<Sandbox> },
	spec: SpecResult,
	onStep: OnStepFn,
): Promise<BuildResult> {
	const sandboxId = crypto.randomUUID().slice(0, 8);
	const sandbox = getSandbox(env.Sandbox, `spawn-${sandboxId}`);
	const files = new Map<string, string>();
	const logLines: string[] = [];

	try {
		const workersai = createWorkersAI({ binding: env.AI });
		const tools = createSandboxTools(sandbox, files, logLines, onStep);

		await generateText({
			model: workersai(MODEL),
			system: BUILD_SYSTEM_PROMPT,
			messages: [{ role: "user", content: specToPrompt(spec) }],
			tools,
			stopWhen: stepCountIs(MAX_STEPS),
		});

		return { files, buildLog: logLines.join("\n\n") };
	} finally {
		await sandbox.destroy();
	}
}

export async function continueProject(
	env: { AI: Ai; Sandbox: DurableObjectNamespace<Sandbox> },
	spec: SpecResult,
	existingFiles: Map<string, string>,
	feedback: string,
	onStep: OnStepFn,
): Promise<BuildResult> {
	const sandboxId = crypto.randomUUID().slice(0, 8);
	const sandbox = getSandbox(env.Sandbox, `spawn-${sandboxId}`);
	const files = new Map(existingFiles);
	const logLines: string[] = [];

	try {
		// Seed sandbox with existing files
		for (const [path, content] of existingFiles) {
			await sandbox.writeFile(`/workspace/${path}`, content);
		}

		const workersai = createWorkersAI({ binding: env.AI });
		const tools = createSandboxTools(sandbox, files, logLines, onStep);

		await generateText({
			model: workersai(MODEL),
			system: buildFeedbackPrompt(feedback),
			messages: [{ role: "user", content: specToPrompt(spec) }],
			tools,
			stopWhen: stepCountIs(MAX_STEPS),
		});

		return { files, buildLog: logLines.join("\n\n") };
	} finally {
		await sandbox.destroy();
	}
}
