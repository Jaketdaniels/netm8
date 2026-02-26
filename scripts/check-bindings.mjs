#!/usr/bin/env node
// scripts/check-bindings.mjs — Verifies all wrangler.jsonc environments declare the same bindings

import { readFileSync } from "node:fs";

const raw = readFileSync("wrangler.jsonc", "utf-8");
const json = JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));

const BINDING_KEYS = ["d1_databases", "kv_namespaces", "r2_buckets", "ai"];

function getBindingNames(config, key) {
	const section = config[key];
	if (!section) return [];
	if (Array.isArray(section)) return section.map((b) => b.binding).sort();
	if (section.binding) return [section.binding];
	return [];
}

let failed = false;

for (const key of BINDING_KEYS) {
	const defaultBindings = getBindingNames(json, key);
	for (const [envName, envCfg] of Object.entries(json.env || {})) {
		const envBindings = getBindingNames(envCfg, key);

		const missing = defaultBindings.filter((b) => !envBindings.includes(b));
		const extra = envBindings.filter((b) => !defaultBindings.includes(b));

		if (missing.length > 0) {
			console.error(`ERROR: ${key} — ${envName} is missing bindings: ${missing.join(", ")}`);
			failed = true;
		}
		if (extra.length > 0) {
			console.error(`ERROR: ${key} — ${envName} has extra bindings: ${extra.join(", ")}`);
			failed = true;
		}
	}
}

if (failed) {
	process.exit(1);
} else {
	console.log("All environments have consistent bindings.");
}
