#!/usr/bin/env node
/**
 * Policy-as-code documentation linter.
 *
 * Prevents drift between internal docs (CLAUDE.md, ADR, CHANGELOG)
 * and the actual codebase (package.json, wrangler.jsonc, schema, migrations,
 * worker routes, frontend routes, CI pipeline, lefthook, configs).
 *
 * Exit 1 on any violation. Runs as part of `npm run check`.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const errors = [];
let policyCount = 0;

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

function allMatches(re, text) {
	return [...text.matchAll(re)].map((m) => m[1]);
}

function readDir(relDir, ext) {
	const full = path.join(ROOT, relDir);
	if (!fs.existsSync(full)) return [];
	return fs.readdirSync(full, { recursive: true }).filter((f) => f.endsWith(ext));
}

function readAllIn(relDir, ext) {
	let combined = "";
	for (const f of readDir(relDir, ext)) {
		combined += `${fs.readFileSync(path.join(ROOT, relDir, f), "utf-8")}\n`;
	}
	return combined;
}

// ── Load sources ────────────────────────────────────────────────────────

const claudeMd = read("CLAUDE.md");
const adr001 = read("docs/adr/001-initial-architecture.md");
const changelog = read("CHANGELOG.md");
const pkgRaw = read("package.json");
const wranglerRaw = read("wrangler.jsonc");
const schemaTs = read("worker/db/schema.ts");
const workerIndex = read("worker/index.ts");
const pipelineYml = read(".github/workflows/pipeline.yml");
const lefthookYml = read("lefthook.yml");
const viteConfig = read("config/vite.config.ts");
const tsconfigApp = read("config/tsconfig.app.json");
const apiClient = read("src/api.ts");

if (!claudeMd) fail("exists", "CLAUDE.md is missing");
if (!adr001) fail("exists", "docs/adr/001-initial-architecture.md is missing");
if (!pkgRaw) fail("exists", "package.json is missing");
if (!wranglerRaw) fail("exists", "wrangler.jsonc is missing");
if (!schemaTs) fail("exists", "worker/db/schema.ts is missing");
if (!workerIndex) fail("exists", "worker/index.ts is missing");

const pkg = pkgRaw ? JSON.parse(pkgRaw) : {};
const wrangler = wranglerRaw ? JSON.parse(stripJsonComments(wranglerRaw)) : {};

// ═══════════════════════════════════════════════════════════════════════
// DOCUMENTATION POLICIES (docs ↔ code)
// ═══════════════════════════════════════════════════════════════════════

// ── 1. CLAUDE.md architecture paths exist ───────────────────────────────
policyCount++;
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

// ── 2. CLAUDE.md commands ↔ package.json scripts ────────────────────────
policyCount++;
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
	const internal = new Set(["seed", "check:bindings", "tail:dev", "tail:deploy"]);
	for (const name of Object.keys(pkg.scripts)) {
		if (!documented.has(name) && !internal.has(name)) {
			fail(
				"claude-commands",
				`package.json has script \`${name}\` but CLAUDE.md Commands section does not document it`,
			);
		}
	}
}

// ── 3. CLAUDE.md stack table ↔ dependencies ─────────────────────────────
policyCount++;
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

// ── 4. ADR bindings ↔ wrangler.jsonc ────────────────────────────────────
policyCount++;
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

// ── 5. ADR environments ↔ wrangler.jsonc ────────────────────────────────
policyCount++;
if (adr001 && wrangler.env) {
	for (const env of Object.keys(wrangler.env)) {
		if (!adr001.includes(env)) {
			fail("adr-envs", `wrangler.jsonc defines env "${env}" but ADR does not mention it`);
		}
	}
}

// ── 6. Drizzle schema ↔ migration DDL (tables + columns) ───────────────
policyCount++;
if (schemaTs) {
	const allMigrationSql = readAllIn("migrations", ".sql");

	const drizzleTables = allMatches(/sqliteTable\(\s*"(\w+)"/g, schemaTs);

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

	for (const m of allMigrationSql.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi)) {
		if (!migrationColumns[m[1]]) migrationColumns[m[1]] = new Set();
		migrationColumns[m[1]].add(m[2]);
	}

	for (const m of allMigrationSql.matchAll(/ALTER TABLE\s+(\w+)\s+DROP COLUMN\s+(\w+)/gi)) {
		migrationColumns[m[1]]?.delete(m[2]);
	}

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

// ── 7. CHANGELOG.md exists and has structure ────────────────────────────
policyCount++;
if (!changelog) {
	fail("changelog", "CHANGELOG.md is missing — create one following Keep a Changelog format");
} else {
	if (!changelog.includes("## [Unreleased]") && !changelog.includes("## Unreleased")) {
		fail("changelog", "CHANGELOG.md must have an [Unreleased] section for pending changes");
	}
	for (const f of readDir("migrations", ".sql")) {
		const name = f.replace(/\.sql$/, "");
		if (!changelog.includes(name)) {
			fail("changelog", `Migration \`${f}\` is not referenced in CHANGELOG.md`);
		}
	}
}

// ── 8. CLAUDE.md Spawn System ↔ codebase ────────────────────────────────
policyCount++;
if (claudeMd) {
	const spawnSection = section(claudeMd, "Spawn System");
	const agentFile = read("worker/agents/spawn-agent.ts");

	if (agentFile) {
		const engineFile = read("worker/services/spawn-engine.ts");
		if (engineFile) {
			const modelMatch = engineFile.match(/const MODEL = "([^"]+)"/);
			if (modelMatch && !spawnSection.includes(modelMatch[1])) {
				fail(
					"claude-spawn",
					`CLAUDE.md Spawn System references a different model than spawn-engine.ts (actual: \`${modelMatch[1]}\`)`,
				);
			}
		}

		const classMatch = agentFile.match(/export class (\w+) extends Agent/);
		if (classMatch && !spawnSection.includes(classMatch[1])) {
			fail(
				"claude-spawn",
				`CLAUDE.md Spawn System does not mention agent class \`${classMatch[1]}\``,
			);
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE POLICIES (config ↔ config)
// ═══════════════════════════════════════════════════════════════════════

// ── 9. Wrangler DO bindings → worker exports ────────────────────────────
policyCount++;
if (wrangler.durable_objects?.bindings && workerIndex) {
	for (const binding of wrangler.durable_objects.bindings) {
		const className = binding.class_name;
		const exportRe = new RegExp(
			`export\\s+\\{\\s*${className}\\s*\\}|export\\s+class\\s+${className}`,
		);
		if (!exportRe.test(workerIndex)) {
			fail(
				"worker-do-exports",
				`wrangler.jsonc has DO binding "${className}" but worker/index.ts does not export it`,
			);
		}
	}
}

// ── 10. Worker env usage → wrangler bindings ────────────────────────────
policyCount++;
if (workerIndex && wrangler) {
	const workerSources = readAllIn("worker", ".ts");
	const envRefs = new Set(allMatches(/(?:c\.env|this\.env)\.(\w+)/g, workerSources));

	// Build set of all binding names from wrangler.jsonc
	const bindingNames = new Set();
	if (wrangler.vars) {
		for (const k of Object.keys(wrangler.vars)) bindingNames.add(k);
	}
	if (wrangler.ai?.binding) bindingNames.add(wrangler.ai.binding);
	for (const db of wrangler.d1_databases ?? []) bindingNames.add(db.binding);
	for (const kv of wrangler.kv_namespaces ?? []) bindingNames.add(kv.binding);
	for (const r2 of wrangler.r2_buckets ?? []) bindingNames.add(r2.binding);
	for (const doBinding of wrangler.durable_objects?.bindings ?? []) {
		bindingNames.add(doBinding.name);
	}
	if (wrangler.assets?.binding) bindingNames.add(wrangler.assets.binding);

	for (const ref of envRefs) {
		if (!bindingNames.has(ref)) {
			fail(
				"worker-env",
				`Worker code references \`env.${ref}\` but no wrangler.jsonc binding provides it`,
			);
		}
	}
}

// ── 11. API routes → test coverage ──────────────────────────────────────
policyCount++;
if (workerIndex) {
	const testSources = readAllIn("tests", ".ts");

	// Extract route patterns from worker/index.ts
	const routePatterns = [
		...workerIndex.matchAll(/\.(get|post|put|patch|delete)\("(\/api\/[^"]+)"/g),
	].map((m) => ({
		method: m[1].toUpperCase(),
		path: m[2],
	}));

	for (const { method, path: routePath } of routePatterns) {
		// Normalize parameterized routes for test matching
		const testPath = routePath
			.replace(/:(\w+)\{\.\+\}/g, "test-val") // :path{.+} → test-val
			.replace(/:(\w+)/g, "test-val"); // :id → test-val

		// Check if any test file fetches this path pattern
		const baseRoute = routePath.replace(/\/:.*$/, "");
		const hasTest =
			testSources.includes(baseRoute) ||
			testSources.includes(testPath) ||
			testSources.includes(routePath);

		if (!hasTest) {
			fail("api-tested", `${method} ${routePath} has no test coverage in tests/`);
		}
	}
}

// ── 12. CI pipeline runs quality gate ───────────────────────────────────
policyCount++;
if (pipelineYml) {
	if (!pipelineYml.includes("npm run check")) {
		fail("ci-quality-gate", "pipeline.yml does not run `npm run check`");
	}
	if (!pipelineYml.includes("check-bindings")) {
		fail("ci-quality-gate", "pipeline.yml does not run check-bindings");
	}
} else {
	fail("ci-quality-gate", ".github/workflows/pipeline.yml is missing");
}

// ── 13. Lefthook ↔ CLAUDE.md conventions ────────────────────────────────
policyCount++;
if (lefthookYml && claudeMd) {
	const conventions = section(claudeMd, "Conventions");

	if (conventions.includes("Biome") && conventions.includes("staged files")) {
		if (!lefthookYml.includes("biome")) {
			fail(
				"lefthook-sync",
				"CLAUDE.md claims Biome runs on staged files but lefthook.yml does not run biome",
			);
		}
	}
	if (conventions.includes("commitlint")) {
		if (!lefthookYml.includes("commitlint")) {
			fail(
				"lefthook-sync",
				"CLAUDE.md claims commitlint is enforced but lefthook.yml does not run commitlint",
			);
		}
	}
	if (lefthookYml.includes("pre-commit") && !conventions.includes("Pre-commit")) {
		fail(
			"lefthook-sync",
			"lefthook.yml has pre-commit hooks but CLAUDE.md Conventions does not mention them",
		);
	}
} else if (!lefthookYml) {
	fail("lefthook-sync", "lefthook.yml is missing");
}

// ── 14. Frontend route files use TanStack Router API ────────────────────
policyCount++;
{
	const routeDir = path.join(ROOT, "src/routes");
	if (fs.existsSync(routeDir)) {
		const routeFiles = fs
			.readdirSync(routeDir, { recursive: true })
			.filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

		for (const f of routeFiles) {
			const content = fs.readFileSync(path.join(routeDir, f), "utf-8");
			const hasRouteApi =
				content.includes("createFileRoute") ||
				content.includes("createRootRoute") ||
				content.includes("createRoute");
			if (!hasRouteApi) {
				fail(
					"routes-valid",
					`src/routes/${f} does not use TanStack Router API (createFileRoute/createRootRoute)`,
				);
			}
		}
	}
}

// ── 15. tsconfig paths ↔ vite resolve.alias ─────────────────────────────
policyCount++;
if (tsconfigApp && viteConfig) {
	const tsconfig = JSON.parse(stripJsonComments(tsconfigApp));
	const tsPaths = Object.keys(tsconfig?.compilerOptions?.paths ?? {});

	for (const alias of tsPaths) {
		// "@/*" → "@"
		const aliasBase = alias.replace("/*", "");
		if (!viteConfig.includes(`"${aliasBase}"`)) {
			fail(
				"config-alias",
				`tsconfig.app.json defines path alias "${alias}" but vite.config.ts does not have a matching resolve.alias`,
			);
		}
	}
}

// ── 16. RPC client imports AppType from worker ──────────────────────────
policyCount++;
if (apiClient) {
	if (!apiClient.includes("AppType")) {
		fail("rpc-type-safe", "src/api.ts does not import AppType — RPC client is not type-safe");
	}
	if (!apiClient.includes("worker/index")) {
		fail(
			"rpc-type-safe",
			"src/api.ts does not import from worker/index — RPC type chain is broken",
		);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// COMPLETENESS POLICIES (nothing orphaned)
// ═══════════════════════════════════════════════════════════════════════

// ── 17. Shared schema exports are imported somewhere ────────────────────
policyCount++;
{
	const schemasFile = read("src/shared/schemas.ts");
	if (schemasFile) {
		const exports = allMatches(/export (?:const|type|interface|function)\s+(\w+)/g, schemasFile);
		// Also catch `export { Foo }` re-exports
		for (const m of schemasFile.matchAll(/export\s+\{([^}]+)\}/g)) {
			for (const name of m[1].split(",").map((s) => s.trim())) {
				if (name) exports.push(name);
			}
		}

		// Read all .ts/.tsx files outside shared/schemas.ts
		const allSrcTs = readAllIn("src", ".ts") + readAllIn("src", ".tsx");
		const allWorkerTs = readAllIn("worker", ".ts");
		const allTestTs = readAllIn("tests", ".ts");
		const combined = allSrcTs + allWorkerTs + allTestTs;

		// Remove the schemas file itself from the search
		const schemasContent = schemasFile;
		const externalCode = combined.replace(schemasContent, "");

		for (const name of exports) {
			// Skip internal-only type aliases that are only used within the schema file
			if (name.startsWith("_")) continue;
			if (!externalCode.includes(name)) {
				fail(
					"schemas-used",
					`src/shared/schemas.ts exports \`${name}\` but it is not imported anywhere else`,
				);
			}
		}
	}
}

// ── 18. Worker index exports AppType ────────────────────────────────────
policyCount++;
if (workerIndex) {
	if (!workerIndex.includes("export type AppType")) {
		fail("worker-apptype", "worker/index.ts does not export AppType — RPC client will break");
	}
	if (!workerIndex.includes("export default")) {
		fail(
			"worker-apptype",
			"worker/index.ts does not have a default export — worker will not start",
		);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// DEAD CODE POLICIES (no unused exports, no orphaned files)
// ═══════════════════════════════════════════════════════════════════════

// ── 19. All exported symbols in worker/db/schema.ts are imported ─────────
policyCount++;
if (schemaTs) {
	const exports = allMatches(/export (?:const|type|interface|function)\s+(\w+)/g, schemaTs);

	const allWorkerTs = readAllIn("worker", ".ts");
	const allTestTs = readAllIn("tests", ".ts");
	const combined = allWorkerTs + allTestTs;
	const externalCode = combined.replace(schemaTs, "");

	for (const name of exports) {
		if (!externalCode.includes(name)) {
			fail(
				"schema-exports-used",
				`worker/db/schema.ts exports \`${name}\` but it is not imported anywhere`,
			);
		}
	}
}

// ── 20. No orphaned files in key directories ─────────────────────────────
policyCount++;
{
	// src/ files (excluding components which are a library) must be imported somewhere
	const allSrcTs = readAllIn("src", ".ts") + readAllIn("src", ".tsx");
	const allWorkerTs = readAllIn("worker", ".ts");
	const allTestTs = readAllIn("tests", ".ts");
	const allCode = allSrcTs + allWorkerTs + allTestTs;

	// Check src/ .ts/.tsx files outside components/ and routes/ (routes are auto-discovered)
	for (const f of readDir("src", ".ts").concat(readDir("src", ".tsx"))) {
		// Skip routes (auto-discovered by TanStack), components (library), generated files
		if (f.startsWith("routes/")) continue;
		if (f.startsWith("components/")) continue;
		if (f === "routeTree.gen.ts") continue;
		if (f === "main.tsx") continue; // entry point referenced by index.html
		if (f === "index.css") continue; // CSS entry

		// The file should be imported somewhere
		const importPath = f.replace(/\.tsx?$/, "");
		const baseName = path.basename(f, path.extname(f));
		const isImported =
			allCode.includes(`/${importPath}"`) ||
			allCode.includes(`/${importPath}'`) ||
			allCode.includes(`/${baseName}"`) ||
			allCode.includes(`/${baseName}'`);

		if (!isImported) {
			fail("no-orphan-files", `src/${f} is not imported by any source file`);
		}
	}

	// Check worker/ .ts files are imported or are the entry point
	for (const f of readDir("worker", ".ts")) {
		if (f === "index.ts") continue; // entry point
		if (f === "global.d.ts") continue; // type declarations

		const importPath = f.replace(/\.tsx?$/, "");
		const baseName = path.basename(f, path.extname(f));
		const isImported =
			allCode.includes(`/${importPath}"`) ||
			allCode.includes(`/${importPath}'`) ||
			allCode.includes(`/${baseName}"`) ||
			allCode.includes(`/${baseName}'`);

		if (!isImported) {
			fail("no-orphan-files", `worker/${f} is not imported by any source file`);
		}
	}

	// Check scripts/ .mjs files are referenced in package.json or CI
	const pkgStr = pkgRaw ?? "";
	const ciStr = pipelineYml ?? "";
	for (const f of readDir("scripts", ".mjs")) {
		if (!pkgStr.includes(f) && !ciStr.includes(f)) {
			fail("no-orphan-files", `scripts/${f} is not referenced in package.json or CI pipeline`);
		}
	}
}

// ── 21. No orphaned asset files ──────────────────────────────────────────
policyCount++;
{
	const allSrcTs = readAllIn("src", ".ts") + readAllIn("src", ".tsx");
	const indexHtml = read("index.html") ?? "";
	const allRefs = allSrcTs + indexHtml;

	// Check src/assets/
	for (const f of readDir("src/assets", "")) {
		if (!allRefs.includes(f)) {
			fail("no-orphan-assets", `src/assets/${f} is not referenced by any source file`);
		}
	}

	// Check public/
	for (const f of readDir("public", "")) {
		if (!allRefs.includes(f) && !indexHtml.includes(f)) {
			fail("no-orphan-assets", `public/${f} is not referenced by any source file or index.html`);
		}
	}
}

// ── 22. .gitignore preserve rules reference existing files ───────────────
policyCount++;
{
	const gitignore = read(".gitignore");
	if (gitignore) {
		for (const m of gitignore.matchAll(/^!(.+)$/gm)) {
			const preserved = m[1];
			// Skip glob patterns
			if (preserved.includes("*")) continue;
			if (!exists(preserved)) {
				fail(
					"gitignore-hygiene",
					`.gitignore preserves \`${preserved}\` but the file does not exist`,
				);
			}
		}
	}
}

// ── 23. No duplicate function definitions across route files ─────────────
policyCount++;
{
	const routeFiles = readDir("src/routes", ".tsx").concat(readDir("src/routes", ".ts"));
	const fnMap = new Map(); // fnName → [files]

	for (const f of routeFiles) {
		const content = fs.readFileSync(path.join(ROOT, "src/routes", f), "utf-8");
		for (const m of content.matchAll(/^(?:export )?function (\w+)\s*[(<]/gm)) {
			const fnName = m[1];
			// Skip component functions (PascalCase) — they're expected to be unique per route
			if (fnName[0] === fnName[0].toUpperCase()) continue;
			if (!fnMap.has(fnName)) fnMap.set(fnName, []);
			fnMap.get(fnName).push(f);
		}
	}

	for (const [fnName, files] of fnMap) {
		if (files.length > 1) {
			fail(
				"no-duplicate-fns",
				`Function \`${fnName}\` is defined in ${files.length} route files (${files.join(", ")}) — extract to a shared module`,
			);
		}
	}
}

// ── 24. Entry point imports CSS ───────────────────────────────────────────
policyCount++;
{
	const mainTsx = read("src/main.tsx");
	if (mainTsx) {
		if (!mainTsx.includes("index.css")) {
			fail("entry-css", "src/main.tsx does not import index.css — the app will render unstyled");
		}
	} else {
		fail("entry-css", "src/main.tsx is missing");
	}
}

// ── 25. Route files have visual tests ──────────────────────────────────
policyCount++;
{
	const routeDir = path.join(ROOT, "src/routes");
	if (fs.existsSync(routeDir)) {
		const routeFiles = fs
			.readdirSync(routeDir, { recursive: true })
			.filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && f !== "__root.tsx");

		const visualDir = path.join(ROOT, "tests/visual");
		const visualFiles = fs.existsSync(visualDir)
			? fs.readdirSync(visualDir).filter((f) => f.endsWith(".spec.ts"))
			: [];

		for (const routeFile of routeFiles) {
			// Convert route file to expected visual test name
			// e.g. "index.tsx" → "home.spec.ts", "spawn/index.tsx" → "spawn.spec.ts"
			// "spawn/$id.tsx" → "spawn-detail.spec.ts", "profile.tsx" → "profile.spec.ts"
			const base = routeFile.replace(/\.tsx?$/, "").replace(/\\/g, "/");
			let testName;
			if (base === "index") testName = "home";
			else if (base === "spawn/index") testName = "spawn";
			else if (base === "spawn/$id") testName = "spawn-detail";
			else if (base === "profile") testName = "profile";
			else testName = base.replace(/\//g, "-");

			const hasVisualTest = visualFiles.some((vf) => vf.startsWith(testName));
			if (!hasVisualTest) {
				fail(
					"route-visual-test",
					`src/routes/${routeFile} has no visual test (expected tests/visual/${testName}.spec.ts)`,
				);
			}
		}
	}
}

// ── 26. ai-elements imports are used in JSX ───────────────────────────
policyCount++;
{
	const routeDir = path.join(ROOT, "src/routes");
	if (fs.existsSync(routeDir)) {
		const routeFiles = fs
			.readdirSync(routeDir, { recursive: true })
			.filter((f) => f.endsWith(".tsx"));

		for (const f of routeFiles) {
			const content = fs.readFileSync(path.join(routeDir, f), "utf-8");
			// Find all named imports from ai-elements
			const importMatches = [
				...content.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']@\/components\/ai-elements\//g),
			];
			for (const m of importMatches) {
				const names = m[1]
					.split(",")
					.map((s) => s.trim().split(" as ").pop().trim())
					.filter(Boolean);
				for (const name of names) {
					// Check if the imported name appears as a JSX tag: <Name or <Name>
					const jsxPattern = new RegExp(`<${name}[\\s/>]`);
					if (!jsxPattern.test(content)) {
						fail(
							"ai-elements-used",
							`src/routes/${f} imports \`${name}\` from ai-elements but never uses it in JSX`,
						);
					}
				}
			}
		}
	}
}

// ── 27. No raw fetch in route files ───────────────────────────────────
policyCount++;
{
	const routeDir = path.join(ROOT, "src/routes");
	if (fs.existsSync(routeDir)) {
		const routeFiles = fs
			.readdirSync(routeDir, { recursive: true })
			.filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

		for (const f of routeFiles) {
			const content = fs.readFileSync(path.join(routeDir, f), "utf-8");
			if (/fetch\s*\(\s*["'`]\/api\//.test(content)) {
				fail(
					"no-raw-fetch",
					`src/routes/${f} uses raw fetch("/api/...") — use the RPC client from src/api.ts instead`,
				);
			}
		}
	}
}

// ── Report ──────────────────────────────────────────────────────────────

if (errors.length === 0) {
	console.log("docs-lint: all %d policies pass", policyCount);
	process.exit(0);
}

console.error(`\ndocs-lint: ${errors.length} violation(s)\n`);
for (const { policy, message } of errors) {
	console.error(`  [${policy}] ${message}`);
}
console.error("");
process.exit(1);
