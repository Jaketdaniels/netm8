/// <reference types="../../worker-configuration.d.ts" />

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type {
	LanguageModelMiddleware,
	StopCondition,
	StreamTextOnFinishCallback,
	ToolCallRepairFunction,
	ToolSet,
} from "ai";
import { stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { type SpecResult, SpecResultSchema } from "../../src/shared/schemas";

// ── Model ───────────────────────────────────────────────────────────────

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const MAX_STEPS = 20;
export type RunProjectStreamMode = "initial" | "feedback";
export const BUILD_TOOL_NAMES = ["write_file", "read_file", "exec", "done"] as const;
type BuildToolName = (typeof BUILD_TOOL_NAMES)[number];

const TOOL_INPUT_SCHEMAS = {
	write_file: z.object({
		path: z.string().describe("Relative file path (e.g. src/index.ts)"),
		content: z.string().describe("Full file content"),
	}),
	read_file: z.object({
		path: z.string().describe("Relative file path to read"),
	}),
	exec: z.object({
		command: z.string().describe("Shell command to execute"),
	}),
	done: z.object({
		summary: z.string().describe("Brief summary of what was built"),
	}),
} as const;

type BuildToolInputSchemas = typeof TOOL_INPUT_SCHEMAS;
type BuildToolArgs<TName extends BuildToolName> = z.infer<BuildToolInputSchemas[TName]>;

const TOOL_DESCRIPTIONS: Record<BuildToolName, string> = {
	write_file: "Write or overwrite a file in the workspace. Path is relative to /workspace/.",
	read_file: "Read the contents of a file in the workspace.",
	exec: "Execute a shell command in the workspace. Use for npm install, npm test, build commands, etc.",
	done: "Signal that the project is complete. Call this when all files are written, tests pass, and the project is ready.",
};

function isBuildToolName(name: string): name is BuildToolName {
	return (BUILD_TOOL_NAMES as readonly string[]).includes(name);
}

type ToolCatalogProperty = {
	type: string;
	description?: string;
	default?: unknown;
};

type ToolCatalogEntry = {
	name: BuildToolName;
	description: string;
	parameters: {
		type: "dict";
		required: string[];
		properties: Record<string, ToolCatalogProperty>;
	};
};

function buildToolCatalog(): ToolCatalogEntry[] {
	return BUILD_TOOL_NAMES.map((toolName) => {
		const schema = z.toJSONSchema(TOOL_INPUT_SCHEMAS[toolName]) as {
			required?: string[];
			properties?: Record<string, { type?: unknown; description?: unknown; default?: unknown }>;
		};

		const properties: Record<string, ToolCatalogProperty> = {};
		for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
			const rawType = propertySchema.type;
			const normalizedType =
				Array.isArray(rawType) && rawType.length > 0
					? String(rawType[0])
					: typeof rawType === "string"
						? rawType
						: "string";

			properties[propertyName] = {
				type: normalizedType,
				description:
					typeof propertySchema.description === "string" ? propertySchema.description : undefined,
				default: propertySchema.default,
			};
		}

		return {
			name: toolName,
			description: TOOL_DESCRIPTIONS[toolName],
			parameters: {
				type: "dict",
				required: schema.required ?? [],
				properties,
			},
		};
	});
}

function buildToolCatalogJson(): string {
	return JSON.stringify(buildToolCatalog(), null, 4);
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

export function buildSystemPrompt(mode: RunProjectStreamMode, feedback?: string): string {
	const toolCatalog = buildToolCatalogJson();
	const modeBlock =
		mode === "feedback"
			? `This is an existing project — the user's files are already in /workspace/.
Apply requested changes only. Do NOT rebuild from scratch.
User feedback: ${feedback ?? "No feedback provided."}`
			: "Build from an empty /workspace/ directory.";

	return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>

You are an expert in composing functions for code generation in a Linux sandbox (Node.js 20 + npm).
You are given a project spec and a set of possible functions/tools.
Based on the project spec, make one or more function/tool calls to complete the software build.
If a required parameter is missing for a function call, point it out and request the missing value.
If none of the functions can be used, point it out.

You should only return function call content in tool-call responses.
If you decide to invoke function(s), you MUST use this format exactly:
[func_name1(param_name1=param_value1, param_name2=param_value2), func_name2(...)]
You SHOULD NOT include any other text in tool-call responses.

Here is the list of functions in JSON format that you can invoke.
${toolCatalog}

Execution workflow requirements:
1. write_file for package.json first (include all dependencies).
2. write_file for each source file (one file per call).
3. exec to run npm install.
4. exec to run tests/build verification.
5. If errors, fix files and re-run exec.
6. Call done(summary=...) only when project is working.
7. done() will fail unless at least one file has been written.

General constraints:
- Call exactly one tool per response.
- Implement every requested feature with production-ready code.
- Paths are relative to /workspace/ (e.g. src/index.ts).
- ${modeBlock}
<|eot_id|><|start_header_id|>assistant<|end_header_id|>`;
}

export const BUILD_SYSTEM_PROMPT = buildSystemPrompt("initial");

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
			description: TOOL_DESCRIPTIONS.write_file,
			inputSchema: TOOL_INPUT_SCHEMAS.write_file,
			execute: async ({ path, content }: BuildToolArgs<"write_file">) => {
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
			description: TOOL_DESCRIPTIONS.read_file,
			inputSchema: TOOL_INPUT_SCHEMAS.read_file,
			execute: async ({ path }: BuildToolArgs<"read_file">) => {
				console.log(`[tool:read_file] Reading: ${path}`);
				const file = await sandbox.readFile(`/workspace/${path}`);
				return file.content;
			},
		}),

		exec: tool({
			description: TOOL_DESCRIPTIONS.exec,
			inputSchema: TOOL_INPUT_SCHEMAS.exec,
			execute: async ({ command }: BuildToolArgs<"exec">) => {
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
			description: TOOL_DESCRIPTIONS.done,
			inputSchema: TOOL_INPUT_SCHEMAS.done,
			execute: async ({ summary }: BuildToolArgs<"done">) => {
				if (files.size === 0) {
					const message =
						"Cannot complete build before writing files. Use write_file to create project files first.";
					console.warn(`[tool:done] Rejected: ${message}`);
					throw new Error(message);
				}
				console.log("[tool:done] Build complete");
				return summary;
			},
		}),
	};
}

type StreamingToolSet = ReturnType<typeof createStreamingTools>;

export function stopWhenDoneWithFiles(files: Map<string, string>): StopCondition<StreamingToolSet> {
	return ({ steps }) => {
		if (files.size === 0 || steps.length === 0) return false;
		const lastStep = steps[steps.length - 1];
		return lastStep.toolResults.some((result) => result.toolName === "done");
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

function extractTopLevelSquareBracketSpans(
	text: string,
): Array<{ start: number; end: number; raw: string }> {
	const spans: Array<{ start: number; end: number; raw: string }> = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let quote: '"' | "'" | null = null;
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
			if (ch === quote) {
				inString = false;
				quote = null;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			continue;
		}

		if (ch === "[") {
			if (depth === 0) {
				start = i;
			}
			depth++;
			continue;
		}

		if (ch === "]" && depth > 0) {
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
	const normalizedToolName = toolNameCandidate.trim();
	if (!isBuildToolName(normalizedToolName)) return null;

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
		toolName: normalizedToolName,
		input: serializeToolInput(rawArgs),
	};
}

function splitTopLevel(text: string, delimiter = ","): string[] {
	const parts: string[] = [];
	let start = 0;
	let paren = 0;
	let brace = 0;
	let bracket = 0;
	let inString = false;
	let quote: '"' | "'" | null = null;
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
			if (ch === quote) {
				inString = false;
				quote = null;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			continue;
		}

		if (ch === "(") paren++;
		else if (ch === ")" && paren > 0) paren--;
		else if (ch === "{") brace++;
		else if (ch === "}" && brace > 0) brace--;
		else if (ch === "[") bracket++;
		else if (ch === "]" && bracket > 0) bracket--;

		if (ch === delimiter && paren === 0 && brace === 0 && bracket === 0) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}

	const final = text.slice(start).trim();
	if (final) parts.push(final);
	return parts.filter(Boolean);
}

function findTopLevelEquals(text: string): number {
	let paren = 0;
	let brace = 0;
	let bracket = 0;
	let inString = false;
	let quote: '"' | "'" | null = null;
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
			if (ch === quote) {
				inString = false;
				quote = null;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			continue;
		}

		if (ch === "(") paren++;
		else if (ch === ")" && paren > 0) paren--;
		else if (ch === "{") brace++;
		else if (ch === "}" && brace > 0) brace--;
		else if (ch === "[") bracket++;
		else if (ch === "]" && bracket > 0) bracket--;
		else if (ch === "=" && paren === 0 && brace === 0 && bracket === 0) return i;
	}

	return -1;
}

function parseBracketValue(rawValue: string): unknown {
	const value = rawValue.trim();
	if (!value) return "";

	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		const unquoted = value.slice(1, -1);
		if (value.startsWith('"')) {
			try {
				return JSON.parse(value);
			} catch {
				return unquoted;
			}
		}
		return unquoted.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
	}

	if (/^-?\d+(?:\.\d+)?$/.test(value)) {
		return Number(value);
	}

	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;

	if (
		(value.startsWith("{") && value.endsWith("}")) ||
		(value.startsWith("[") && value.endsWith("]"))
	) {
		const normalized = normalizeJsonObjectString(value) ?? value;
		try {
			return JSON.parse(normalized);
		} catch {
			return value;
		}
	}

	return value;
}

function parseBracketArguments(argsText: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const args = splitTopLevel(argsText, ",");
	for (const arg of args) {
		const eq = findTopLevelEquals(arg);
		if (eq <= 0) continue;
		const key = arg.slice(0, eq).trim();
		if (!key) continue;
		const rawValue = arg.slice(eq + 1).trim();
		out[key] = parseBracketValue(rawValue);
	}
	return out;
}

function parseBracketToolCalls(text: string): ParsedTextToolCall[] | null {
	const calls: ParsedTextToolCall[] = [];
	const spans = extractTopLevelSquareBracketSpans(text);

	for (const span of spans) {
		const raw = span.raw.trim();
		if (!raw.startsWith("[") || !raw.endsWith("]")) continue;
		const inner = raw.slice(1, -1).trim();
		if (!inner || !inner.includes("(")) continue;

		const segments = splitTopLevel(inner, ",");
		for (const segment of segments) {
			const match = segment.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/);
			if (!match) continue;

			const toolName = match[1].trim();
			if (!isBuildToolName(toolName)) continue;

			const argsText = match[2]?.trim() ?? "";
			const args = argsText ? parseBracketArguments(argsText) : {};
			calls.push({
				toolName,
				input: serializeToolInput(args),
				range: { start: span.start, end: span.end },
			});
		}
	}

	return calls.length > 0 ? calls : null;
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

	const bracketCalls = parseBracketToolCalls(text);
	if (bracketCalls) {
		calls.push(...bracketCalls);
	}

	return calls.length > 0 ? calls : null;
}

function stripMatchedToolCallText(text: string, calls: ParsedTextToolCall[]): string {
	if (calls.length === 0) return text;

	const uniqueByRange = [
		...new Map(calls.map((call) => [`${call.range.start}:${call.range.end}`, call])).values(),
	];
	const sorted = uniqueByRange.sort((a, b) => b.range.start - a.range.start);
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

export const repairMalformedToolCall: ToolCallRepairFunction<StreamingToolSet> = async ({
	toolCall,
}) => {
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

export function runProjectStream({
	env,
	spec,
	sandbox,
	files,
	onFileWrite,
	onFinish,
	onReasoningUpdate,
	mode,
	feedback,
}: {
	env: { AI: Ai; CACHE?: KVNamespace };
	spec: SpecResult;
	sandbox: ReturnType<typeof getSandbox>;
	files: Map<string, string>;
	onFileWrite: (path: string, content: string) => void;
	onFinish?: StreamTextOnFinishCallback<ToolSet>;
	onReasoningUpdate?: (text: string) => void;
	mode: RunProjectStreamMode;
	feedback?: string;
}) {
	const model = createModel(env);
	const tools = createStreamingTools(sandbox, files, onFileWrite);
	const systemPrompt = buildSystemPrompt(mode, feedback);

	if (mode === "initial") {
		console.log("[runProjectStream] Starting build for:", spec.name);
	}

	return streamText({
		model,
		system: systemPrompt,
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		toolChoice: "auto",
		maxOutputTokens: 4096,
		stopWhen: [stopWhenDoneWithFiles(files), stepCountIs(MAX_STEPS)],
		experimental_repairToolCall: repairMalformedToolCall,
		onStepFinish: (event) => {
			if (mode === "initial") {
				console.log(
					`[runProjectStream] Step finished: finishReason=${event.finishReason}, toolCalls=${event.toolCalls?.length ?? 0}, text=${event.text?.slice(0, 200) ?? "(none)"}`,
				);
			}
			if (event.text?.trim()) {
				onReasoningUpdate?.(event.text.trim());
			}
		},
		onFinish: onFinish
			? (event) => onFinish(event as unknown as Parameters<StreamTextOnFinishCallback<ToolSet>>[0])
			: undefined,
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
