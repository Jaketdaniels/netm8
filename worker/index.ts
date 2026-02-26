/// <reference types="../worker-configuration.d.ts" />

import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { users } from "../src/db/schema";
import { CreateUserSchema } from "../src/shared/schemas";

const app = new Hono<{ Bindings: Cloudflare.Env }>();

// ── Middleware ──────────────────────────────────────────────────────────
app.use("*", secureHeaders());
app.use("/api/*", cors());
app.use("/api/*", logger());

// ── Routes ─────────────────────────────────────────────────────────────
const api = app
	.get("/api/health", (c) => {
		return c.json({ name: "netm8", version: "0.1.0", env: c.env.ENVIRONMENT });
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
	});

// ── Fallback ───────────────────────────────────────────────────────────
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// ── Error handler ──────────────────────────────────────────────────────
app.onError((err, c) => {
	console.error(err);
	return c.json({ error: "Internal server error" }, 500);
});

export type AppType = typeof api;
export default app;
