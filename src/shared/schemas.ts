import { z } from "zod";

export const CreateUserSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1).max(200).optional(),
});

export const UpdateUserSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	avatarUrl: z.string().url().optional(),
});

// ── Spec (one-shot: extract intent from user prompt) ────────────────────

export const SpecResultSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	platform: z.enum(["ios", "android", "web", "desktop", "cli", "api"]),
	features: z.array(z.string().min(1)).min(1).max(20),
});
export type SpecResult = z.infer<typeof SpecResultSchema>;

export const SPEC_JSON_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string" },
		description: { type: "string" },
		platform: { type: "string", enum: ["ios", "android", "web", "desktop", "cli", "api"] },
		features: { type: "array", items: { type: "string" } },
	},
	required: ["name", "description", "platform", "features"],
} as const;

// ── Agent Step (tool-calling loop events) ───────────────────────────────

const AgentStepSchema = z.object({
	id: z.string(),
	type: z.enum(["tool_call", "tool_result", "text"]),
	toolName: z.enum(["write_file", "exec", "read_file", "done"]).optional(),
	toolArgs: z.record(z.string(), z.unknown()).optional(),
	result: z.string().optional(),
	content: z.string().optional(),
	timestamp: z.string(),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;
