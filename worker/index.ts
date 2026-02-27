/// <reference types="../worker-configuration.d.ts" />
/// <reference path="./global.d.ts" />

import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { agentsMiddleware } from "hono-agents";
import { CreateUserSchema, UpdateUserSchema } from "../src/shared/schemas";
import { spawnFiles, spawns, users } from "./db/schema";
import { requestLogger } from "./middleware/request-logger";

export { Sandbox } from "@cloudflare/sandbox";
// Re-export Durable Object classes (required by Workers runtime)
export { SpawnAgent } from "./agents/spawn-agent";

type AppEnv = {
	Bindings: Cloudflare.Env;
	Variables: { requestId: string };
};

const app = new Hono<AppEnv>();

// ── Middleware ──────────────────────────────────────────────────────────
// agentsMiddleware MUST run first — DO responses have immutable headers
// that secureHeaders() cannot modify.
app.use("*", agentsMiddleware());
app.use("/api/*", secureHeaders());
app.use("/api/*", requestLogger());
app.use("/api/*", cors());

// ── Routes ─────────────────────────────────────────────────────────────
const api = app
	.get("/api/health", async (c) => {
		const checks: Record<string, "ok" | string> = {};

		try {
			await drizzle(c.env.DB).select().from(users).limit(1);
			checks.d1 = "ok";
		} catch (e: any) {
			checks.d1 = e.message;
		}

		try {
			await c.env.CACHE.list({ limit: 1 });
			checks.kv = "ok";
		} catch (e: any) {
			checks.kv = e.message;
		}

		try {
			await c.env.STORAGE.list({ limit: 1 });
			checks.r2 = "ok";
		} catch (e: any) {
			checks.r2 = e.message;
		}

		const healthy = Object.values(checks).every((v) => v === "ok");

		return c.json(
			{
				name: "netm8",
				version: __APP_VERSION__,
				env: c.env.ENVIRONMENT,
				status: healthy ? "healthy" : "degraded",
				checks,
			},
			healthy ? 200 : 503,
		);
	})
	.get("/api/users", async (c) => {
		const db = drizzle(c.env.DB);
		const result = await db.select().from(users);
		return c.json(result);
	})
	.get("/api/users/:id", async (c) => {
		const id = c.req.param("id");
		const db = drizzle(c.env.DB);
		const result = await db.select().from(users).where(eq(users.id, id));
		if (result.length === 0) {
			return c.json({ error: "User not found" }, 404);
		}
		return c.json(result[0]);
	})
	.post("/api/users", zValidator("json", CreateUserSchema), async (c) => {
		const data = c.req.valid("json");
		const db = drizzle(c.env.DB);
		const result = await db.insert(users).values(data).returning();
		return c.json(result[0], 201);
	})
	.put("/api/users/:id", zValidator("json", UpdateUserSchema), async (c) => {
		const id = c.req.param("id");
		const data = c.req.valid("json");
		const db = drizzle(c.env.DB);
		const result = await db
			.update(users)
			.set({ ...data, updatedAt: new Date().toISOString() })
			.where(eq(users.id, id))
			.returning();
		if (result.length === 0) return c.json({ error: "User not found" }, 404);
		return c.json(result[0]);
	})

	// ── Spawn routes (read-only — spawns are created via SpawnAgent WebSocket) ──

	.get("/api/spawns", async (c) => {
		const db = drizzle(c.env.DB);
		const result = await db.select().from(spawns).orderBy(desc(spawns.createdAt)).limit(50);
		return c.json(result);
	})

	.get("/api/spawns/:id", async (c) => {
		const id = c.req.param("id");
		const db = drizzle(c.env.DB);
		const [spawn] = await db.select().from(spawns).where(eq(spawns.id, id));
		if (!spawn) return c.json({ error: "Spawn not found" }, 404);

		const files = await db.select().from(spawnFiles).where(eq(spawnFiles.spawnId, id));

		return c.json({ ...spawn, files });
	})

	.get("/api/spawns/:id/files", async (c) => {
		const id = c.req.param("id");
		const db = drizzle(c.env.DB);
		const files = await db.select().from(spawnFiles).where(eq(spawnFiles.spawnId, id));
		return c.json(files);
	})

	.delete("/api/spawns/:id", async (c) => {
		const id = c.req.param("id");
		const db = drizzle(c.env.DB);
		const [spawn] = await db.select().from(spawns).where(eq(spawns.id, id));
		if (!spawn) return c.json({ error: "Spawn not found" }, 404);

		await db.delete(spawnFiles).where(eq(spawnFiles.spawnId, id));
		await db.delete(spawns).where(eq(spawns.id, id));

		return c.body(null, 204);
	})

	// ── Upload routes (R2 storage) ──

	.post("/api/uploads", async (c) => {
		const formData = await c.req.formData();
		const file = formData.get("file") as File | null;
		if (!file) return c.json({ error: "No file" }, 400);
		const key = `uploads/${crypto.randomUUID()}/${file.name}`;
		await c.env.STORAGE.put(key, file.stream(), {
			httpMetadata: { contentType: file.type },
		});
		return c.json({ url: key, filename: file.name, mediaType: file.type }, 201);
	})

	.get("/api/uploads/:key{.+}", async (c) => {
		const key = c.req.param("key");
		const obj = await c.env.STORAGE.get(key);
		if (!obj) return c.json({ error: "Not found" }, 404);
		const headers = new Headers();
		obj.writeHttpMetadata(headers);
		return new Response(obj.body, { headers });
	})

	.get("/api/spawns/:id/files/:path{.+}", async (c) => {
		const id = c.req.param("id");
		const filePath = c.req.param("path");
		const db = drizzle(c.env.DB);
		const [file] = await db
			.select()
			.from(spawnFiles)
			.where(and(eq(spawnFiles.spawnId, id), eq(spawnFiles.path, filePath)));

		if (!file) return c.json({ error: "File not found" }, 404);
		return c.text(file.content);
	});

// ── Fallback ───────────────────────────────────────────────────────────
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// ── Error handler ──────────────────────────────────────────────────────
app.onError((err, c) => {
	const requestId = c.get("requestId");
	console.error(
		JSON.stringify({
			requestId,
			method: c.req.method,
			path: c.req.path,
			error: err.message,
			stack: err.stack,
		}),
	);
	return c.json({ error: "Internal server error", requestId }, 500);
});

export type AppType = typeof api;
export default app;
