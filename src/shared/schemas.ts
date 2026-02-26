import { z } from "zod";

export const CreateUserSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1).max(200).optional(),
});

export const UserIdSchema = z.object({
	id: z.string().uuid(),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
