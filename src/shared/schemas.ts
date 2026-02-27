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
	summary: z.string().min(1),
});
export type SpecResult = z.infer<typeof SpecResultSchema>;
