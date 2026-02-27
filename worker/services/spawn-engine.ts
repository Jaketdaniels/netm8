/// <reference types="../../worker-configuration.d.ts" />

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type {
	LanguageModelMiddleware,
	StreamTextOnFinishCallback,
	ToolCallRepairFunction,
	ToolSet,
} from "ai";
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
- Call one tool per response. Before calling, briefly state what you're doing (1 sentence max).
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

type ParsedTextToolCall = {
	toolName: string;
	input: string;
	range: { start: number; end: number };
};

type MutableGeneratePart = {
	type: string;
	text?: string;
	[key: string]: unknown;
};

type MutableGenerateResult = {
	content?: MutableGeneratePart[];
	finishReason?: { unified?: string; [key: string]: unknown };
};

function extractTopLevelJsonObjectSpans(
	text: string,
): Array<{ start: number; end: number; raw: string }> {
	const spans: Array<{ start: number; end: number; raw: string }> = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			if (depth === 0) {
				start = i;
			}
			depth++;
			continue;
		}

		if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				spans.push({
					start,
					end: i + 1,
					raw: text.slice(start, i + 1),
				});
				start = -1;
			}
		}
	}

	return spans;
}

function normalizeJsonObjectString(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return JSON.stringify({});

	const candidates = new Set<string>();
	const addCandidate = (candidate: string | null | undefined) => {
		if (!candidate) return;
		const normalized = candidate.trim();
		if (normalized) {
			candidates.add(normalized);
		}
	};

	addCandidate(trimmed);

	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	addCandidate(fenced?.[1]);

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		addCandidate(trimmed.slice(1, -1));
	}

	const singleQuoteJson = trimmed
		.replace(/([{,]\s*)'([^'\\]+)'\s*:/g, '$1"$2":')
		.replace(
			/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[,}])/g,
			(_match, value: string, trailing: string) =>
				`:${JSON.stringify(value.replace(/\\'/g, "'"))}${trailing}`,
		);
	addCandidate(singleQuoteJson);

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(parsed);
			}
		} catch {
			// Keep trying candidates.
		}
	}

	return null;
}

function serializeToolInput(rawInput: unknown): string {
	if (rawInput == null) return "{}";

	if (typeof rawInput === "string") {
		const normalized = normalizeJsonObjectString(rawInput);
		return normalized ?? rawInput.trim();
	}

	return JSON.stringify(rawInput);
}

function normalizeToolCallObject(obj: unknown): { toolName: string; input: string } | null {
	if (!obj || typeof obj !== "object") return null;

	const record = obj as Record<string, unknown>;
	const functionObj =
		record.function && typeof record.function === "object"
			? (record.function as Record<string, unknown>)
			: null;

	const toolNameCandidate =
		functionObj?.name ?? functionObj?.toolName ?? record.name ?? record.toolName ?? record.tool;
	if (typeof toolNameCandidate !== "string" || toolNameCandidate.trim() === "") return null;

	const rawArgs =
		functionObj?.parameters ??
		functionObj?.arguments ??
		functionObj?.input ??
		functionObj?.args ??
		record.parameters ??
		record.arguments ??
		record.input ??
		record.args ??
		{};

	return {
		toolName: toolNameCandidate,
		input: serializeToolInput(rawArgs),
	};
}

export function parseTextToolCalls(text: string): ParsedTextToolCall[] | null {
	const calls: ParsedTextToolCall[] = [];
	const spans = extractTopLevelJsonObjectSpans(text);

	for (const span of spans) {
		try {
			const parsed = JSON.parse(span.raw);
			const call = normalizeToolCallObject(parsed);
			if (call) {
				calls.push({
					...call,
					range: { start: span.start, end: span.end },
				});
			}
		} catch {
			// Ignore non-JSON object spans.
		}
	}

	return calls.length > 0 ? calls : null;
}

function stripMatchedToolCallText(text: string, calls: ParsedTextToolCall[]): string {
	if (calls.length === 0) return text;

	const sorted = [...calls].sort((a, b) => b.range.start - a.range.start);
	let out = text;
	for (const call of sorted) {
		out = out.slice(0, call.range.start) + out.slice(call.range.end);
	}
	return out.trim();
}

function recoverToolCallsFromTextParts(content: MutableGeneratePart[]): {
	content: MutableGeneratePart[];
	recoveredToolCalls: number;
} {
	const next: MutableGeneratePart[] = [];
	let recoveredToolCalls = 0;

	for (const part of content) {
		if (part.type !== "text" || typeof part.text !== "string") {
			next.push(part);
			continue;
		}

		const parsed = parseTextToolCalls(part.text);
		if (!parsed) {
			next.push(part);
			continue;
		}

		const cleanText = stripMatchedToolCallText(part.text, parsed);
		if (cleanText) {
			next.push({ ...part, text: cleanText });
		}

		for (const call of parsed) {
			next.push({
				type: "tool-call",
				toolCallId: `tc_${crypto.randomUUID().slice(0, 8)}`,
				toolName: call.toolName,
				input: call.input,
			});
			recoveredToolCalls++;
		}
	}

	return { content: next, recoveredToolCalls };
}

function normalizeResultToolCalls(result: MutableGenerateResult): {
	recoveredToolCalls: number;
	toolCallCount: number;
} {
	const hasStructuredToolCalls = result.content?.some((part) => part.type === "tool-call") ?? false;
	let recoveredToolCalls = 0;

	if (!hasStructuredToolCalls && result.content) {
		const recovered = recoverToolCallsFromTextParts(result.content);
		result.content = recovered.content;
		recoveredToolCalls = recovered.recoveredToolCalls;
	}

	const toolCallCount = result.content?.filter((part) => part.type === "tool-call").length ?? 0;
	if (toolCallCount > 0 && result.finishReason?.unified === "stop") {
		result.finishReason = { ...result.finishReason, unified: "tool-calls" };
	}

	return { recoveredToolCalls, toolCallCount };
}

function repairToolCallInput(rawInput: string): string | null {
	const normalized = normalizeJsonObjectString(rawInput);
	if (!normalized) return null;

	try {
		const parsed = JSON.parse(normalized) as Record<string, unknown>;
		const functionObj =
			parsed.function && typeof parsed.function === "object"
				? (parsed.function as Record<string, unknown>)
				: null;

		const nestedInput =
			functionObj?.parameters ??
			functionObj?.arguments ??
			functionObj?.input ??
			functionObj?.args ??
			parsed.parameters ??
			parsed.arguments ??
			parsed.input ??
			parsed.args;

		if (nestedInput !== undefined) {
			return serializeToolInput(nestedInput);
		}

		return JSON.stringify(parsed);
	} catch {
		return normalized;
	}
}

export const repairMalformedToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall }) => {
	const repairedInput = repairToolCallInput(toolCall.input);
	if (repairedInput) {
		return { ...toolCall, input: repairedInput };
	}

	const parsedTextCalls = parseTextToolCalls(toolCall.input);
	if (!parsedTextCalls || parsedTextCalls.length === 0) return null;

	const matchedCall =
		parsedTextCalls.find((call) => call.toolName === toolCall.toolName) ?? parsedTextCalls[0];

	return {
		...toolCall,
		toolName: matchedCall.toolName,
		input: matchedCall.input,
	};
};

function toolCallMiddleware(kv?: KVNamespace): LanguageModelMiddleware {
	return {
		specificationVersion: "v3",

		// Non-streaming: check for text-based tool calls if no structured ones
		wrapGenerate: async ({ doGenerate }) => {
			const result = await doGenerate();
			normalizeResultToolCalls(result as MutableGenerateResult);

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

			const recovery = normalizeResultToolCalls(result as MutableGenerateResult);

			// Log final content after extraction
			const finalTypes = result.content?.map((p: { type: string }) => p.type) ?? [];
			const toolCalls =
				result.content?.filter((p: { type: string }) => p.type === "tool-call") ?? [];
			console.log(
				`[middleware:wrapStream] after extraction: [${finalTypes.join(", ")}], tool calls: ${toolCalls.length}, recovered=${recovery.recoveredToolCalls}, finishReason: ${result.finishReason?.unified}`,
			);

			// Simulate a stream from the generate result.
			// Keep tool-call parts in V3 format ({ input }) so streamText can parse
			// and execute tools in the multi-step loop.
			const simulatedStream = createSimulatedStreamFromGenerateResult(result);

			return {
				stream: simulatedStream,
				request: result.request,
				response: result.response,
			};
		},
	};
}

type SimulatedGenerateResult = {
	warnings: unknown[];
	response?: unknown;
	content: Array<{ type: string; [key: string]: unknown }>;
	finishReason: unknown;
	usage: unknown;
	providerMetadata?: unknown;
};

export function createSimulatedStreamFromGenerateResult(result: SimulatedGenerateResult) {
	let id = 0;
	return new ReadableStream({
		start(controller) {
			controller.enqueue({ type: "stream-start", warnings: result.warnings });
			if (result.response && typeof result.response === "object") {
				controller.enqueue({
					type: "response-metadata",
					...(result.response as Record<string, unknown>),
				});
			}

			for (const part of result.content) {
				switch (part.type) {
					case "text": {
						const text = typeof part.text === "string" ? part.text : "";
						if (text.length > 0) {
							controller.enqueue({ type: "text-start", id: String(id) });
							controller.enqueue({
								type: "text-delta",
								id: String(id),
								delta: text,
							});
							controller.enqueue({ type: "text-end", id: String(id) });
							id++;
						}
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
	onFinish?: StreamTextOnFinishCallback<ToolSet>,
	onReasoningUpdate?: (text: string) => void,
) {
	const model = createModel(env);
	const tools = createStreamingTools(sandbox, files, onFileWrite);

	console.log("[buildProjectStream] Starting build for:", spec.name);
	return streamText({
		model,
		system: BUILD_SYSTEM_PROMPT,
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		toolChoice: "auto",
		maxOutputTokens: 4096,
		stopWhen: [hasToolCall("done"), stepCountIs(MAX_STEPS)],
		experimental_repairToolCall: repairMalformedToolCall,
		onStepFinish: (event) => {
			console.log(
				`[buildProjectStream] Step finished: finishReason=${event.finishReason}, toolCalls=${event.toolCalls?.length ?? 0}, text=${event.text?.slice(0, 200) ?? "(none)"}`,
			);
			if (event.text?.trim()) {
				onReasoningUpdate?.(event.text.trim());
			}
		},
		onFinish,
	});
}

export function continueProjectStream(
	env: { AI: Ai; CACHE?: KVNamespace },
	spec: SpecResult,
	sandbox: ReturnType<typeof getSandbox>,
	files: Map<string, string>,
	feedback: string,
	onFileWrite: (path: string, content: string) => void,
	onFinish?: StreamTextOnFinishCallback<ToolSet>,
	onReasoningUpdate?: (text: string) => void,
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
		stopWhen: [hasToolCall("done"), stepCountIs(MAX_STEPS)],
		experimental_repairToolCall: repairMalformedToolCall,
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
