/// <reference types="../worker-configuration.d.ts" />
/// <reference path="./global.d.ts" />

import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { spawnFiles, spawnStages, spawns, users } from "../src/db/schema";
import { CreateUserSchema, SpawnPromptSchema } from "../src/shared/schemas";
import { requestLogger } from "./middleware/request-logger";
import { executeSpawn } from "./services/spawn-engine";

type AppEnv = {
	Bindings: Cloudflare.Env;
	Variables: { requestId: string };
};

const app = new Hono<AppEnv>();

// ── Middleware ──────────────────────────────────────────────────────────
app.use("*", secureHeaders());
app.use("*", requestLogger());
app.use("/api/*", cors());

// ── Routes ─────────────────────────────────────────────────────────────
const api = app
	.get("/api/health", (c) => {
		return c.json({
			name: "netm8",
			version: __APP_VERSION__,
			env: c.env.ENVIRONMENT,
		});
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

	// ── Spawn routes ─────────────────────────────────────────────────────

	.post("/api/spawns", zValidator("json", SpawnPromptSchema), async (c) => {
		const { prompt } = c.req.valid("json");
		const db = drizzle(c.env.DB);
		const [spawn] = await db.insert(spawns).values({ prompt }).returning();

		c.header("Content-Encoding", "Identity");
		let eventId = 0;
		return streamSSE(c, async (stream) => {
			await stream.writeSSE({
				data: JSON.stringify({ spawnId: spawn.id, prompt }),
				event: "init",
				id: String(eventId++),
			});

			const emit = async (event: string, data: string) => {
				await stream.writeSSE({ data, event, id: String(eventId++) });
			};

			await executeSpawn(c.env, spawn.id, prompt, emit);
		});
	})

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
		const stages = await db.select().from(spawnStages).where(eq(spawnStages.spawnId, id));

		return c.json({ ...spawn, files, stages });
	})

	.get("/api/spawns/:id/files", async (c) => {
		const id = c.req.param("id");
		const db = drizzle(c.env.DB);
		const files = await db.select().from(spawnFiles).where(eq(spawnFiles.spawnId, id));
		return c.json(files);
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
