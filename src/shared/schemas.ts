import { z } from "zod";

export const CreateUserSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1).max(200).optional(),
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

// ── Iteration operations (the AI returns these each loop) ───────────────

const CreateOpSchema = z.object({
	op: z.literal("create"),
	path: z.string().min(1),
	content: z.string().min(1),
});

const EditLineSchema = z.object({
	line: z.number().int().positive(),
	action: z.enum(["+", "-"]),
	text: z.string(),
});

const EditOpSchema = z.object({
	op: z.literal("edit"),
	path: z.string().min(1),
	diffs: z.array(EditLineSchema).min(1),
});

const DeleteOpSchema = z.object({
	op: z.literal("delete"),
	path: z.string().min(1),
});

const DoneOpSchema = z.object({
	op: z.literal("done"),
	summary: z.string().min(1),
});

const OperationSchema = z.discriminatedUnion("op", [
	CreateOpSchema,
	EditOpSchema,
	DeleteOpSchema,
	DoneOpSchema,
]);
export type Operation = z.infer<typeof OperationSchema>;

/** The AI returns an array of operations per iteration */
export const IterationResultSchema = z.object({
	operations: z.array(OperationSchema).min(1),
	reasoning: z.string().min(1),
});
export type IterationResult = z.infer<typeof IterationResultSchema>;

export const ITERATION_JSON_SCHEMA = {
	type: "object",
	properties: {
		operations: {
			type: "array",
			items: {
				type: "object",
				properties: {
					op: { type: "string", enum: ["create", "edit", "delete", "done"] },
					path: { type: "string" },
					content: { type: "string" },
					diffs: {
						type: "array",
						items: {
							type: "object",
							properties: {
								line: { type: "integer" },
								action: { type: "string", enum: ["+", "-"] },
								text: { type: "string" },
							},
							required: ["line", "action", "text"],
						},
					},
					summary: { type: "string" },
				},
				required: ["op"],
			},
		},
		reasoning: { type: "string" },
	},
	required: ["operations", "reasoning"],
} as const;
