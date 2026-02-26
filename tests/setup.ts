/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), email TEXT NOT NULL UNIQUE, name TEXT, avatar_url TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
	);
	await env.DB.exec("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)");
});
