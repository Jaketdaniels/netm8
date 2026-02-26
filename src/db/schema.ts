import { sql } from "drizzle-orm";
import { sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	email: text("email").unique().notNull(),
	name: text("name"),
	avatarUrl: text("avatar_url"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ── Spawn tables ────────────────────────────────────────────────────────

export const spawns = sqliteTable("spawns", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	prompt: text("prompt").notNull(),
	name: text("name"),
	description: text("description"),
	platform: text("platform"),
	features: text("features"), // JSON array
	status: text("status").notNull().default("pending"),
	error: text("error"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export type Spawn = typeof spawns.$inferSelect;
export type NewSpawn = typeof spawns.$inferInsert;

export const spawnFiles = sqliteTable(
	"spawn_files",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		spawnId: text("spawn_id")
			.notNull()
			.references(() => spawns.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		content: text("content").notNull(),
		language: text("language"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => [unique().on(t.spawnId, t.path)],
);

export type SpawnFile = typeof spawnFiles.$inferSelect;
