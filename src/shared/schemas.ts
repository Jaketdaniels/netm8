import { z } from "zod";

export const CreateUserSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1).max(200).optional(),
});

export const UserIdSchema = z.object({
	id: z.string().uuid(),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

// ── Spawn schemas ───────────────────────────────────────────────────────

export const SpawnPromptSchema = z.object({
	prompt: z.string().min(3).max(2000),
});

export type SpawnPromptInput = z.infer<typeof SpawnPromptSchema>;

export const SPAWN_STAGES = ["seed", "sprout", "grow", "bloom", "harvest"] as const;
export type SpawnStageName = (typeof SPAWN_STAGES)[number];

export const SPAWN_STATUSES = ["pending", "running", "complete", "failed"] as const;
export type SpawnStatus = (typeof SPAWN_STATUSES)[number];
