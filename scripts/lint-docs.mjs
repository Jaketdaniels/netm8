#!/usr/bin/env node
/**
 * Policy-as-code documentation linter.
 *
 * Prevents drift between internal docs (CLAUDE.md, ADR, CHANGELOG)
 * and the actual codebase (package.json, wrangler.jsonc, schema, migrations).
 *
 * Exit 1 on any violation. Runs as part of `npm run check`.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const errors = [];

function fail(policy, message) {
	errors.push({ policy, message });
}

function read(relPath) {
	const full = path.join(ROOT, relPath);
	if (!fs.existsSync(full)) return null;
	return fs.readFileSync(full, "utf-8");
}

function exists(relPath) {
	return fs.existsSync(path.join(ROOT, relPath));
}

function stripJsonComments(text) {
	return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function section(markdown, heading) {
	const lines = markdown.split("\n");
	let capturing = false;
	const result = [];
	for (const line of lines) {
		if (line.startsWith(`## ${heading}`)) {
			capturing = true;
			continue;
		}
		if (capturing && line.startsWith("## ")) break;
		if (capturing) result.push(line);
	}
	return result.join("\n");
}

/** Extract all capture-group-1 matches from a string */
function allMatches(re, text) {
	return [...text.matchAll(re)].map((m) => m[1]);
}

// ── Load sources ────────────────────────────────────────────────────────

const claudeMd = read("CLAUDE.md");
const adr001 = read("docs/adr/001-initial-architecture.md");
const changelog = read("CHANGELOG.md");
const pkgRaw = read("package.json");
const wranglerRaw = read("wrangler.jsonc");
const schemaTs = read("src/db/schema.ts");

if (!claudeMd) fail("exists", "CLAUDE.md is missing");
if (!adr001) fail("exists", "docs/adr/001-initial-architecture.md is missing");
if (!pkgRaw) fail("exists", "package.json is missing");
if (!wranglerRaw) fail("exists", "wrangler.jsonc is missing");
if (!schemaTs) fail("exists", "src/db/schema.ts is missing");

const pkg = pkgRaw ? JSON.parse(pkgRaw) : {};
const wrangler = wranglerRaw ? JSON.parse(stripJsonComments(wranglerRaw)) : {};

// ── Policy 1: CLAUDE.md architecture paths exist ────────────────────────

if (claudeMd) {
	const arch = section(claudeMd, "Architecture");
	for (const m of arch.matchAll(/`([^`]+\/[^`]+)`/g)) {
		const p = m[1];
		if (p.includes("*") || p.includes("://")) continue;
		const target = p.endsWith("/") ? p.slice(0, -1) : p;
		if (!exists(target)) {
			fail("claude-paths", `Architecture references \`${p}\` but it does not exist`);
		}
	}
}

// ── Policy 2: CLAUDE.md commands match package.json scripts ─────────────

if (claudeMd && pkg.scripts) {
	const cmds = section(claudeMd, "Commands");
	const documented = new Set(allMatches(/npm run (\S+)/g, cmds));

	for (const name of documented) {
		if (!pkg.scripts[name]) {
			fail(
				"claude-commands",
				`CLAUDE.md documents \`npm run ${name}\` but it is not in package.json scripts`,
			);
		}
	}
	// Reverse check: scripts missing from docs (skip internal/rarely-used ones)
	const internal = new Set([
		"seed",
		"check:bindings",
		"db:snapshot",
		"db:restore",
		"tail:dev",
		"tail:deploy",
	]);
	for (const name of Object.keys(pkg.scripts)) {
		if (!documented.has(name) && !internal.has(name)) {
			fail(
				"claude-commands",
				`package.json has script \`${name}\` but CLAUDE.md Commands section does not document it`,
			);
		}
	}
}

// ── Policy 3: CLAUDE.md stack table matches dependencies ────────────────

if (claudeMd && pkg.dependencies) {
	const stack = section(claudeMd, "Stack");
	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

	const stackMap = {
		"React 19": ["react"],
		Vite: ["vite"],
		"TanStack Router": ["@tanstack/react-router"],
		"TanStack Query": ["@tanstack/react-query"],
		Hono: ["hono"],
		"Drizzle ORM": ["drizzle-orm"],
		Zod: ["zod"],
		Biome: ["@biomejs/biome"],
		Vitest: ["vitest"],
	};

	for (const [displayName, packages] of Object.entries(stackMap)) {
		if (stack.includes(displayName)) {
			for (const dep of packages) {
				if (!allDeps[dep]) {
					fail(
						"claude-stack",
						`Stack table claims "${displayName}" but \`${dep}\` is not in package.json`,
					);
				}
			}
		}
	}
}

// ── Policy 4: ADR binding claims match wrangler.jsonc ───────────────────

if (adr001 && wrangler) {
	const bindingChecks = [
		{ key: "d1_databases", label: "D1 database", patterns: ["D1"] },
		{ key: "kv_namespaces", label: "KV namespace", patterns: ["KV"] },
		{ key: "r2_buckets", label: "R2 bucket", patterns: ["R2"] },
		{ key: "ai", label: "AI binding", patterns: ["Workers AI", "AI binding", "`AI`"] },
	];

	for (const { key, label, patterns } of bindingChecks) {
		const adrMentions = patterns.some((p) => adr001.includes(p));
		const configHas =
			key === "ai" ? !!wrangler.ai : Array.isArray(wrangler[key]) && wrangler[key].length > 0;

		if (adrMentions && !configHas) {
			fail("adr-bindings", `ADR claims ${label} but wrangler.jsonc has no ${key} config`);
		}
		if (configHas && !adrMentions) {
			fail("adr-bindings", `wrangler.jsonc has ${key} config but ADR does not mention ${label}`);
		}
	}

	const adrMentionsDO = adr001.includes("Durable Object") || adr001.includes("durable_objects");
	const configHasDO = wrangler.durable_objects?.bindings?.length > 0;
	if (adrMentionsDO && !configHasDO) {
		fail(
			"adr-bindings",
			"ADR mentions Durable Objects but wrangler.jsonc has no durable_objects bindings",
		);
	}
	if (configHasDO && !adrMentionsDO) {
		fail(
			"adr-bindings",
			"wrangler.jsonc has durable_objects bindings but ADR does not mention Durable Objects",
		);
	}
}

// ── Policy 5: ADR environments match wrangler.jsonc ─────────────────────

if (adr001 && wrangler.env) {
	for (const env of Object.keys(wrangler.env)) {
		if (!adr001.includes(env)) {
			fail("adr-envs", `wrangler.jsonc defines env "${env}" but ADR does not mention it`);
		}
	}
}

// ── Policy 6: Drizzle schema tables have matching migrations ────────────

if (schemaTs) {
	const migrationDir = path.join(ROOT, "migrations");
	let allMigrationSql = "";
	if (fs.existsSync(migrationDir)) {
		const files = fs
			.readdirSync(migrationDir)
			.filter((f) => f.endsWith(".sql"))
			.sort();
		for (const f of files) {
			allMigrationSql += `${fs.readFileSync(path.join(migrationDir, f), "utf-8")}\n`;
		}
	}

	// Drizzle tables
	const drizzleTables = allMatches(/sqliteTable\(\s*"(\w+)"/g, schemaTs);

	// Migration tables (CREATE minus DROP)
	const createdTables = new Set(
		allMatches(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/gi, allMigrationSql),
	);
	for (const t of allMatches(/DROP TABLE(?:\s+IF EXISTS)?\s+(\w+)/gi, allMigrationSql)) {
		createdTables.delete(t);
	}

	for (const table of drizzleTables) {
		if (!createdTables.has(table)) {
			fail(
				"schema-drift",
				`Drizzle schema defines table "${table}" but no migration creates it (or it was dropped)`,
			);
		}
	}
	for (const table of createdTables) {
		if (!drizzleTables.includes(table)) {
			fail(
				"schema-drift",
				`Migration creates table "${table}" but Drizzle schema does not define it`,
			);
		}
	}

	// Drizzle columns per table (brace-depth parser for multi-line definitions)
	const drizzleColumns = {};
	for (const m of schemaTs.matchAll(/sqliteTable\(\s*"(\w+)",\s*\{/g)) {
		const tableName = m[1];
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		while (i < schemaTs.length && depth > 0) {
			if (schemaTs[i] === "{") depth++;
			if (schemaTs[i] === "}") depth--;
			i++;
		}
		const block = schemaTs.slice(start, i - 1);
		drizzleColumns[tableName] = new Set(allMatches(/\w+:\s*text\("(\w+)"\)/g, block));
	}

	// Migration columns per surviving table
	const migrationColumns = {};
	for (const m of allMigrationSql.matchAll(
		/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\);/gi,
	)) {
		const tableName = m[1];
		if (!createdTables.has(tableName)) continue;
		const cols = new Set();
		for (const line of m[2].split("\n")) {
			const colMatch = line.trim().match(/^(\w+)\s+TEXT/i);
			if (colMatch) cols.add(colMatch[1]);
		}
		migrationColumns[tableName] = cols;
	}

	// Account for ALTER TABLE DROP COLUMN
	for (const m of allMigrationSql.matchAll(/ALTER TABLE\s+(\w+)\s+DROP COLUMN\s+(\w+)/gi)) {
		migrationColumns[m[1]]?.delete(m[2]);
	}

	// Compare columns for tables that exist in both
	for (const table of drizzleTables) {
		const dCols = drizzleColumns[table];
		const mCols = migrationColumns[table];
		if (!dCols || !mCols) continue;

		for (const col of dCols) {
			if (!mCols.has(col)) {
				fail(
					"schema-drift",
					`Drizzle schema has column "${table}.${col}" but migrations do not define it`,
				);
			}
		}
		for (const col of mCols) {
			if (!dCols.has(col)) {
				fail(
					"schema-drift",
					`Migration defines column "${table}.${col}" but Drizzle schema does not include it`,
				);
			}
		}
	}
}

// ── Policy 7: CHANGELOG.md exists and has structure ─────────────────────

if (!changelog) {
	fail("changelog", "CHANGELOG.md is missing — create one following Keep a Changelog format");
} else {
	if (!changelog.includes("## [Unreleased]") && !changelog.includes("## Unreleased")) {
		fail("changelog", "CHANGELOG.md must have an [Unreleased] section for pending changes");
	}

	const migrationDir = path.join(ROOT, "migrations");
	if (fs.existsSync(migrationDir)) {
		const migrations = fs
			.readdirSync(migrationDir)
			.filter((f) => f.endsWith(".sql"))
			.sort();
		for (const migration of migrations) {
			const name = migration.replace(/\.sql$/, "");
			if (!changelog.includes(name)) {
				fail("changelog", `Migration \`${migration}\` is not referenced in CHANGELOG.md`);
			}
		}
	}
}

// ── Policy 8: CLAUDE.md Spawn System section matches codebase ───────────

if (claudeMd) {
	const spawnSection = section(claudeMd, "Spawn System");
	const agentFile = read("worker/agents/spawn-agent.ts");

	if (agentFile) {
		const engineFile = read("worker/services/spawn-engine.ts");
		if (engineFile) {
			const modelMatch = engineFile.match(/const MODEL = "([^"]+)"/);
			if (modelMatch) {
				const actualModel = modelMatch[1];
				if (!spawnSection.includes(actualModel)) {
					fail(
						"claude-spawn",
						`CLAUDE.md Spawn System references a different model than spawn-engine.ts (actual: \`${actualModel}\`)`,
					);
				}
			}
		}

		const classMatch = agentFile.match(/export class (\w+) extends Agent/);
		if (classMatch) {
			const className = classMatch[1];
			if (!spawnSection.includes(className)) {
				fail(
					"claude-spawn",
					`CLAUDE.md Spawn System does not mention agent class \`${className}\``,
				);
			}
		}
	}
}

// ── Report ──────────────────────────────────────────────────────────────

if (errors.length === 0) {
	console.log("docs-lint: all policies pass (%d checks)", 8);
	process.exit(0);
}

console.error(`\ndocs-lint: ${errors.length} violation(s)\n`);
for (const { policy, message } of errors) {
	console.error(`  [${policy}] ${message}`);
}
console.error("");
process.exit(1);
