#!/usr/bin/env node
// scripts/gradual-rollout.mjs — Gradual deployment with auto-rollback
// Usage: node scripts/gradual-rollout.mjs --env production --health-url https://netm8.com/api/health

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

function getArg(name) {
	const idx = args.indexOf(`--${name}`);
	return idx !== -1 ? args[idx + 1] : null;
}

const env = getArg("env") || "production";
const healthUrl = getArg("health-url");
const waitMinutes = Number.parseInt(getArg("wait") || "5", 10);
const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

function run(cmd) {
	return execSync(cmd, { encoding: "utf-8" }).trim();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHealth(url, expectedVersion, attempts = 3) {
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url);
			const data = await res.json();
			if (data.version === expectedVersion) return true;
		} catch {
			// retry
		}
		await sleep(2000);
	}
	return false;
}

async function main() {
	if (!healthUrl) {
		console.error("Missing --health-url argument");
		process.exit(1);
	}

	console.log(`Uploading new version to ${env}...`);
	const uploadOutput = run(`npx wrangler versions upload --env ${env} --message "v${pkg.version}"`);
	console.log(uploadOutput);

	console.log("Listing versions...");
	const versionsOutput = run(`npx wrangler versions list --env ${env} --json`);
	const versions = JSON.parse(versionsOutput);

	if (versions.length < 2) {
		console.log("First deployment — promoting directly to 100%.");
		const newId = versions[0].id;
		run(`npx wrangler versions deploy ${newId}@100% --env ${env} -y`);
		console.log("Deployed 100%.");
		return;
	}

	const newId = versions[0].id;
	const oldId = versions[1].id;

	console.log(`Canary: ${newId}@5%, stable: ${oldId}@95%`);
	run(`npx wrangler versions deploy ${oldId}@95% ${newId}@5% --env ${env} -y`);

	console.log(`Waiting ${waitMinutes} minutes for canary soak...`);
	await sleep(waitMinutes * 60 * 1000);

	console.log("Checking health...");
	const healthy = await checkHealth(healthUrl, pkg.version);

	if (healthy) {
		console.log("Health check passed. Promoting to 100%...");
		run(`npx wrangler versions deploy ${newId}@100% --env ${env} -y`);
		console.log("Rollout complete.");
	} else {
		console.error("Health check FAILED. Rolling back...");
		run(`npx wrangler versions deploy ${oldId}@100% --env ${env} -y`);
		console.error("Rolled back to previous version.");
		process.exit(1);
	}
}

main();
