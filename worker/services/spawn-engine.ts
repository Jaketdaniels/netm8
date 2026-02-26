/// <reference types="../../worker-configuration.d.ts" />

import type { z } from "zod";
import {
	ITERATION_JSON_SCHEMA,
	type IterationResult,
	IterationResultSchema,
	type Operation,
	SPEC_JSON_SCHEMA,
	type SpecResult,
	SpecResultSchema,
} from "../../src/shared/schemas";

// ── Types ───────────────────────────────────────────────────────────────

export interface ProjectFile {
	path: string;
	content: string;
}

export interface IterationEvent {
	iteration: number;
	operations: Operation[];
	reasoning: string;
}

export type EmitFn = (event: string, data: unknown) => Promise<void>;

// ── Model ───────────────────────────────────────────────────────────────

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const MAX_ITERATIONS = 20;

// ── AI helpers ──────────────────────────────────────────────────────────

function extractResponse(result: unknown): string {
	if (result instanceof ReadableStream) {
		throw new Error("Unexpected stream response — use non-streaming mode");
	}
	const response = (result as { response?: string | null }).response;
	if (!response) throw new Error("Workers AI returned an empty response");
	return response;
}

async function askAIJSON<T>(
	ai: Ai,
	system: string,
	prompt: string,
	schema: z.ZodType<T>,
	jsonSchema: object,
	maxTokens = 4096,
): Promise<T> {
	const result = await ai.run(MODEL, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: prompt },
		],
		max_tokens: maxTokens,
		response_format: {
			type: "json_schema",
			json_schema: jsonSchema,
		},
	});

	const raw = extractResponse(result);
	const json = JSON.parse(raw);
	const parsed = schema.safeParse(json);

	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		throw new Error(`AI response failed validation: ${issues}`);
	}

	return parsed.data;
}

// ── Spec (one-shot) ─────────────────────────────────────────────────────

export async function extractSpec(ai: Ai, prompt: string): Promise<SpecResult> {
	const system = `You are a software architect. Given a natural language description, extract a structured specification.
Rules:
- "name" must be a short kebab-case identifier
- "description" must be a single sentence
- "platform" must be one of: ios, android, web, desktop, cli, api
- "features" must list 3-8 distinct features`;

	return askAIJSON(ai, system, prompt, SpecResultSchema, SPEC_JSON_SCHEMA);
}

// ── Iteration (the core loop) ───────────────────────────────────────────

function buildProjectContext(files: Map<string, string>): string {
	if (files.size === 0) return "No files exist yet.";

	const parts: string[] = [];
	for (const [path, content] of files) {
		parts.push(`--- ${path} ---\n${content}`);
	}
	return parts.join("\n\n");
}

const ITERATION_SYSTEM = `You are a software engineer building a project iteratively.

You will receive:
- The project spec (name, description, platform, features)
- All current project files (or "No files exist yet" on the first iteration)
- The iteration number
- Any user feedback

Return a JSON object with:
- "operations": an array of operations to perform
- "reasoning": a brief explanation of what you're doing and why

Operations:
- {"op":"create","path":"src/index.ts","content":"..."} — create a new file
- {"op":"edit","path":"src/index.ts","diffs":[{"line":5,"action":"-","text":"old line"},{"line":5,"action":"+","text":"new line"}]} — edit a file with line diffs
- {"op":"delete","path":"src/old.ts"} — remove a file
- {"op":"done","summary":"Project complete: ..."} — signal completion

Rules:
- On the FIRST iteration, use "create" operations to scaffold the project
- On subsequent iterations, prefer "edit" over "create" for existing files
- Each iteration should make meaningful progress — don't do too little
- Include a "done" operation when the project is fully functional
- File paths must be relative (e.g. "src/index.ts", not "/src/index.ts")
- Edit diffs reference line numbers in the CURRENT file content
- For edits: "-" removes the line, "+" inserts a line at that position`;

export async function runIteration(
	ai: Ai,
	spec: SpecResult,
	files: Map<string, string>,
	iteration: number,
	feedback: string | null,
): Promise<IterationResult> {
	const projectContext = buildProjectContext(files);

	let prompt = `Project: ${spec.name} — ${spec.description}
Platform: ${spec.platform}
Features: ${spec.features.join(", ")}

Iteration: ${iteration}

Current project files:
${projectContext}`;

	if (feedback) {
		prompt += `\n\nUser feedback: ${feedback}`;
	}

	if (iteration === 1) {
		prompt += "\n\nThis is the first iteration. Scaffold the project with all essential files.";
	} else {
		prompt +=
			"\n\nReview the existing files. Fix bugs, add missing functionality, improve code quality. If the project is complete and functional, include a done operation.";
	}

	return askAIJSON(
		ai,
		ITERATION_SYSTEM,
		prompt,
		IterationResultSchema,
		ITERATION_JSON_SCHEMA,
		8192,
	);
}

// ── Apply operations to file map ────────────────────────────────────────

export function applyOperations(
	files: Map<string, string>,
	operations: Operation[],
): { created: string[]; edited: string[]; deleted: string[] } {
	const created: string[] = [];
	const edited: string[] = [];
	const deleted: string[] = [];

	for (const op of operations) {
		switch (op.op) {
			case "create":
				files.set(op.path, op.content);
				created.push(op.path);
				break;

			case "edit": {
				const existing = files.get(op.path);
				if (!existing) break;
				const lines = existing.split("\n");
				// Apply diffs in reverse line order to keep line numbers stable
				const sorted = [...op.diffs].sort((a, b) => b.line - a.line);
				for (const diff of sorted) {
					const idx = diff.line - 1;
					if (diff.action === "-" && idx >= 0 && idx < lines.length) {
						lines.splice(idx, 1);
					} else if (diff.action === "+") {
						lines.splice(Math.min(idx, lines.length), 0, diff.text);
					}
				}
				files.set(op.path, lines.join("\n"));
				edited.push(op.path);
				break;
			}

			case "delete":
				if (files.delete(op.path)) {
					deleted.push(op.path);
				}
				break;

			case "done":
				// No file mutation — handled by the caller
				break;
		}
	}

	return { created, edited, deleted };
}

// ── Full spawn loop ─────────────────────────────────────────────────────

export async function executeSpawnLoop(
	ai: Ai,
	spec: SpecResult,
	emit: EmitFn,
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	let feedback: string | null = null;

	for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
		await emit("iteration:start", { iteration });

		const result = await runIteration(ai, spec, files, iteration, feedback);

		const { created, edited, deleted } = applyOperations(files, result.operations);
		const isDone = result.operations.some((op) => op.op === "done");
		const doneSummary = result.operations.find((op) => op.op === "done");

		await emit("iteration:complete", {
			iteration,
			reasoning: result.reasoning,
			created,
			edited,
			deleted,
			isDone,
			summary: isDone && doneSummary?.op === "done" ? doneSummary.summary : null,
			totalFiles: files.size,
		});

		if (isDone) break;
		feedback = null;
	}

	return files;
}
