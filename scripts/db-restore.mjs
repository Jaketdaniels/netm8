#!/usr/bin/env node
// scripts/db-restore.mjs — D1 Time Travel snapshot and restore helpers

import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const command = args[0];

const DB_MAP = {
	production: "netm8-db",
	staging: "netm8-db-staging",
};

function run(cmd) {
	execSync(cmd, { stdio: "inherit" });
}

function usage() {
	console.log(`Usage:
  node scripts/db-restore.mjs snapshot [--env staging|production]
  node scripts/db-restore.mjs restore --timestamp <ISO8601> [--env staging|production]

Examples:
  node scripts/db-restore.mjs snapshot
  node scripts/db-restore.mjs snapshot --env staging
  node scripts/db-restore.mjs restore --timestamp "2026-02-25T12:00:00Z"
  node scripts/db-restore.mjs restore --timestamp "2026-02-25T12:00:00Z" --env staging`);
	process.exit(1);
}

function getEnv() {
	const envIdx = args.indexOf("--env");
	return envIdx !== -1 ? args[envIdx + 1] : "production";
}

function getDbName() {
	const env = getEnv();
	const db = DB_MAP[env];
	if (!db) {
		console.error(`Unknown environment: ${env}. Use "staging" or "production".`);
		process.exit(1);
	}
	return db;
}

if (!command) usage();

if (command === "snapshot") {
	const db = getDbName();
	console.log(`Fetching Time Travel info for ${db}...`);
	run(`npx wrangler d1 time-travel info ${db}`);
} else if (command === "restore") {
	const tsIdx = args.indexOf("--timestamp");
	if (tsIdx === -1 || !args[tsIdx + 1]) {
		console.error("Missing --timestamp argument.");
		usage();
	}
	const timestamp = args[tsIdx + 1];
	const db = getDbName();
	console.log(`Restoring ${db} to ${timestamp}...`);
	run(`npx wrangler d1 time-travel restore ${db} --timestamp "${timestamp}"`);
} else {
	usage();
}
