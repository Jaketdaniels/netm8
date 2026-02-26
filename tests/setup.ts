/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

const migrations = import.meta.glob("../migrations/*.sql", {
	eager: true,
	query: "?raw",
	import: "default",
}) as Record<string, string>;

beforeAll(async () => {
	const files = Object.keys(migrations).sort();
	for (const file of files) {
		const statements = migrations[file]
			.replace(/--.*$/gm, "")
			.split(";")
			.map((s) => s.replace(/\s+/g, " ").trim())
			.filter(Boolean);
		for (const stmt of statements) {
			await env.DB.exec(`${stmt};`);
		}
	}
});
