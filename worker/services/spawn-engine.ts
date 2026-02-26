/// <reference types="../../worker-configuration.d.ts" />

import { and, eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { spawnFiles, spawnStages, spawns } from "../../src/db/schema";
import type { SpawnStageName } from "../../src/shared/schemas";

// ── Types ───────────────────────────────────────────────────────────────

interface SeedResult {
	name: string;
	description: string;
	platform: string;
	features: string[];
}

interface SproutFile {
	path: string;
	language: string;
	purpose: string;
}

interface SproutResult {
	files: SproutFile[];
	techStack: Record<string, string>;
	entryPoint: string;
}

interface GrowResult {
	filesGenerated: number;
}

interface BloomFix {
	path: string;
	issue: string;
}

interface BloomResult {
	fixes: BloomFix[];
	summary: string;
}

interface HarvestResult {
	totalFiles: number;
	archiveKey: string;
}

type StageResult = SeedResult | SproutResult | GrowResult | BloomResult | HarvestResult;

type SSEWriter = (event: string, data: string) => Promise<void>;

// ── Model ───────────────────────────────────────────────────────────────

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

// ── AI helper ───────────────────────────────────────────────────────────

async function askAI(ai: Ai, system: string, prompt: string): Promise<string> {
	const result = await ai.run(MODEL, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: prompt },
		],
		max_tokens: 4096,
	});

	if (result instanceof ReadableStream) {
		const reader = result.getReader();
		const decoder = new TextDecoder();
		let text = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text;
	}
	return (result as { response: string }).response;
}

function extractJSON(raw: string): string {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return fenced[1].trim();
	const braceMatch = raw.match(/[[{][\s\S]*[\]}]/);
	if (braceMatch) return braceMatch[0].trim();
	return raw.trim();
}

// ── Stage runners ───────────────────────────────────────────────────────

async function runSeed(
	ai: Ai,
	db: DrizzleD1Database,
	spawnId: string,
	prompt: string,
	emit: SSEWriter,
): Promise<SeedResult> {
	await emit("stage", JSON.stringify({ stage: "seed", status: "running" }));

	const system = `You are a software architect. Given a natural language description of software, extract a structured specification. Respond ONLY with valid JSON, no markdown fences, no explanation.
Output format:
{
  "name": "short-kebab-case-name",
  "description": "One sentence describing the software",
  "platform": "ios|android|web|desktop|cli|api",
  "features": ["feature1", "feature2", "feature3"]
}`;

	const raw = await askAI(ai, system, prompt);
	const parsed = JSON.parse(extractJSON(raw)) as SeedResult;

	await db
		.update(spawns)
		.set({
			name: parsed.name,
			description: parsed.description,
			platform: parsed.platform,
			features: JSON.stringify(parsed.features),
			stage: "seed",
			updatedAt: new Date().toISOString(),
		})
		.where(eq(spawns.id, spawnId));

	await emit("seed", JSON.stringify(parsed));
	return parsed;
}

async function runSprout(
	ai: Ai,
	db: DrizzleD1Database,
	spawnId: string,
	seed: SeedResult,
	emit: SSEWriter,
): Promise<SproutResult> {
	await emit("stage", JSON.stringify({ stage: "sprout", status: "running" }));

	const system = `You are a software architect. Given a software specification, design the file structure and architecture. Every file must be a REAL file that would exist in a working project. Respond ONLY with valid JSON, no markdown fences.
Output format:
{
  "files": [
    {"path": "src/main.ts", "language": "typescript", "purpose": "Entry point"},
    ...
  ],
  "techStack": {"runtime": "Node.js", "framework": "Express", ...},
  "entryPoint": "src/main.ts"
}
Rules:
- Include ALL necessary files: configs, source, assets, etc.
- Use appropriate languages/frameworks for the platform
- Keep the project focused and minimal but complete
- Maximum 15 files for a clean MVP`;

	const prompt = `Software: ${seed.name}
Description: ${seed.description}
Platform: ${seed.platform}
Features: ${seed.features.join(", ")}`;

	const raw = await askAI(ai, system, prompt);
	const parsed = JSON.parse(extractJSON(raw)) as SproutResult;

	await db
		.update(spawns)
		.set({
			architecture: JSON.stringify(parsed),
			stage: "sprout",
			updatedAt: new Date().toISOString(),
		})
		.where(eq(spawns.id, spawnId));

	await emit("sprout", JSON.stringify(parsed));
	return parsed;
}

async function runGrow(
	ai: Ai,
	db: DrizzleD1Database,
	spawnId: string,
	seed: SeedResult,
	sprout: SproutResult,
	emit: SSEWriter,
): Promise<GrowResult> {
	await emit("stage", JSON.stringify({ stage: "grow", status: "running" }));

	const techContext = Object.entries(sprout.techStack)
		.map(([k, v]) => `${k}: ${v}`)
		.join(", ");

	const fileList = sprout.files.map((f) => `${f.path} (${f.purpose})`).join("\n");

	let generated = 0;

	for (const file of sprout.files) {
		const system = `You are a senior software engineer. Generate the COMPLETE source code for a single file in a project. Output ONLY the raw file content — no markdown fences, no explanation, no file path header. The code must be production-ready, functional, and consistent with the project architecture.`;

		const prompt = `Project: ${seed.name} — ${seed.description}
Platform: ${seed.platform}
Tech stack: ${techContext}
Features: ${seed.features.join(", ")}

All project files:
${fileList}

Generate the COMPLETE content for: ${file.path}
Purpose: ${file.purpose}
Language: ${file.language}`;

		const content = await askAI(ai, system, prompt);

		await db
			.insert(spawnFiles)
			.values({
				spawnId,
				path: file.path,
				content,
				language: file.language,
				stage: "grow",
			})
			.onConflictDoUpdate({
				target: [spawnFiles.spawnId, spawnFiles.path],
				set: { content, stage: "grow" },
			});

		generated++;
		await emit(
			"file",
			JSON.stringify({
				path: file.path,
				language: file.language,
				size: content.length,
				index: generated,
				total: sprout.files.length,
			}),
		);
	}

	await db
		.update(spawns)
		.set({ stage: "grow", updatedAt: new Date().toISOString() })
		.where(eq(spawns.id, spawnId));

	return { filesGenerated: generated };
}

async function runBloom(
	ai: Ai,
	db: DrizzleD1Database,
	spawnId: string,
	seed: SeedResult,
	emit: SSEWriter,
): Promise<BloomResult> {
	await emit("stage", JSON.stringify({ stage: "bloom", status: "running" }));

	const files = await db.select().from(spawnFiles).where(eq(spawnFiles.spawnId, spawnId));

	const fileSummary = files
		.map((f) => `--- ${f.path} (${f.language}) ---\n${f.content.slice(0, 800)}`)
		.join("\n\n");

	const system = `You are a code reviewer. Examine the generated project files and identify critical issues that would prevent the software from running. For each issue, provide the file path and a fix. Respond ONLY with valid JSON, no markdown fences.
Output format:
{
  "fixes": [
    {"path": "src/main.ts", "issue": "Missing import for Router", "fixedContent": "COMPLETE corrected file content here"}
  ],
  "summary": "Brief review summary"
}
If no fixes needed, return: {"fixes": [], "summary": "All files look correct"}`;

	const prompt = `Project: ${seed.name} — ${seed.description}
Files for review:
${fileSummary}`;

	const raw = await askAI(ai, system, prompt);
	let parsed: {
		fixes: Array<{ path: string; issue: string; fixedContent?: string }>;
		summary: string;
	};
	try {
		parsed = JSON.parse(extractJSON(raw));
	} catch {
		parsed = { fixes: [], summary: "Review complete" };
	}

	for (const fix of parsed.fixes) {
		if (fix.fixedContent) {
			await db
				.update(spawnFiles)
				.set({ content: fix.fixedContent, stage: "bloom" })
				.where(and(eq(spawnFiles.spawnId, spawnId), eq(spawnFiles.path, fix.path)));
		}
	}

	await db
		.update(spawns)
		.set({ stage: "bloom", updatedAt: new Date().toISOString() })
		.where(eq(spawns.id, spawnId));

	const result: BloomResult = {
		fixes: parsed.fixes.map((f) => ({ path: f.path, issue: f.issue })),
		summary: parsed.summary,
	};
	await emit("bloom", JSON.stringify(result));
	return result;
}

async function runHarvest(
	db: DrizzleD1Database,
	storage: R2Bucket,
	spawnId: string,
	seed: SeedResult,
	emit: SSEWriter,
): Promise<HarvestResult> {
	await emit("stage", JSON.stringify({ stage: "harvest", status: "running" }));

	const files = await db.select().from(spawnFiles).where(eq(spawnFiles.spawnId, spawnId));

	// Store each file individually in R2 for retrieval
	for (const file of files) {
		await storage.put(`spawns/${spawnId}/${file.path}`, file.content, {
			customMetadata: { language: file.language ?? "text", spawnId },
		});
	}

	// Store a manifest for the entire project
	const manifest = {
		name: seed.name,
		description: seed.description,
		platform: seed.platform,
		files: files.map((f) => ({ path: f.path, language: f.language })),
		createdAt: new Date().toISOString(),
	};
	const archiveKey = `spawns/${spawnId}/manifest.json`;
	await storage.put(archiveKey, JSON.stringify(manifest, null, 2));

	await db
		.update(spawns)
		.set({ stage: "harvest", status: "complete", updatedAt: new Date().toISOString() })
		.where(eq(spawns.id, spawnId));

	const result: HarvestResult = { totalFiles: files.length, archiveKey };
	await emit("harvest", JSON.stringify(result));
	return result;
}

// ── Stage tracker ───────────────────────────────────────────────────────

async function trackStage(
	db: DrizzleD1Database,
	spawnId: string,
	stage: SpawnStageName,
	runner: () => Promise<StageResult>,
): Promise<StageResult> {
	const [record] = await db
		.insert(spawnStages)
		.values({
			spawnId,
			stage,
			status: "running",
			startedAt: new Date().toISOString(),
		})
		.returning();

	try {
		const result = await runner();
		await db
			.update(spawnStages)
			.set({
				status: "complete",
				output: JSON.stringify(result),
				completedAt: new Date().toISOString(),
			})
			.where(eq(spawnStages.id, record.id));
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await db
			.update(spawnStages)
			.set({
				status: "failed",
				output: JSON.stringify({ error: message }),
				completedAt: new Date().toISOString(),
			})
			.where(eq(spawnStages.id, record.id));
		throw err;
	}
}

// ── Main orchestrator ───────────────────────────────────────────────────

export async function executeSpawn(
	env: Cloudflare.Env,
	spawnId: string,
	prompt: string,
	emit: SSEWriter,
): Promise<void> {
	const db = drizzle(env.DB);

	await db
		.update(spawns)
		.set({ status: "running", updatedAt: new Date().toISOString() })
		.where(eq(spawns.id, spawnId));

	try {
		const seedResult = (await trackStage(db, spawnId, "seed", () =>
			runSeed(env.AI, db, spawnId, prompt, emit),
		)) as SeedResult;

		const sproutResult = (await trackStage(db, spawnId, "sprout", () =>
			runSprout(env.AI, db, spawnId, seedResult, emit),
		)) as SproutResult;

		await trackStage(db, spawnId, "grow", () =>
			runGrow(env.AI, db, spawnId, seedResult, sproutResult, emit),
		);

		await trackStage(db, spawnId, "bloom", () => runBloom(env.AI, db, spawnId, seedResult, emit));

		await trackStage(db, spawnId, "harvest", () =>
			runHarvest(db, env.STORAGE, spawnId, seedResult, emit),
		);

		await emit("complete", JSON.stringify({ spawnId, status: "complete" }));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await db
			.update(spawns)
			.set({ status: "failed", error: message, updatedAt: new Date().toISOString() })
			.where(eq(spawns.id, spawnId));
		await emit("error", JSON.stringify({ spawnId, error: message }));
	}
}
