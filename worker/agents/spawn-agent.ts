/// <reference types="../../worker-configuration.d.ts" />

import { Agent, type Connection } from "agents";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AgentStep, SpecResult } from "../../src/shared/schemas";
import { spawnFiles, spawns } from "../db/schema";
import { buildProject, continueProject, extractSpec } from "../services/spawn-engine";

// ── State ───────────────────────────────────────────────────────────────

export interface SpawnAgentState {
	spawnId: string | null;
	prompt: string | null;
	status: "idle" | "extracting-spec" | "building" | "complete" | "failed";
	spec: SpecResult | null;
	steps: AgentStep[];
	files: Record<string, string>;
	buildLog: string | null;
	error: string | null;
}

// ── Agent ───────────────────────────────────────────────────────────────

export class SpawnAgent extends Agent<Cloudflare.Env, SpawnAgentState> {
	initialState: SpawnAgentState = {
		spawnId: null,
		prompt: null,
		status: "idle",
		spec: null,
		steps: [],
		files: {},
		buildLog: null,
		error: null,
	};

	async onMessage(_connection: Connection, message: string) {
		const data = JSON.parse(message);

		switch (data.type) {
			case "spawn":
				if (this.state.status !== "building" && this.state.status !== "extracting-spec") {
					await this.startSpawn(data.prompt);
				}
				break;

			case "feedback":
				if (this.state.status === "complete") {
					await this.continueWithFeedback(data.prompt);
				}
				break;

			case "retry":
				if (
					(this.state.status === "complete" || this.state.status === "failed") &&
					this.state.prompt
				) {
					await this.retrySpawn();
				}
				break;
		}
	}

	private async startSpawn(prompt: string) {
		this.setState({
			...this.initialState,
			prompt,
			status: "extracting-spec",
		});

		try {
			// 1. Extract spec
			const spec = await extractSpec(this.env.AI, prompt);

			// Create D1 record
			const db = drizzle(this.env.DB);
			const [spawn] = await db
				.insert(spawns)
				.values({
					prompt,
					name: spec.name,
					description: spec.description,
					platform: spec.platform,
					features: JSON.stringify(spec.features),
					status: "running",
				})
				.returning();

			this.setState({ ...this.state, spawnId: spawn.id, spec, status: "building" });

			// 2. Run tool-calling build loop
			const onStep = (step: AgentStep) => {
				const steps = [...this.state.steps, step];
				const files = { ...this.state.files };

				if (step.toolName === "write_file" && step.toolArgs) {
					files[step.toolArgs.path as string] = step.toolArgs.content as string;
				}

				const buildLog =
					step.toolName === "exec" && step.result
						? `${this.state.buildLog ?? ""}${this.state.buildLog ? "\n\n" : ""}${step.result}`
						: this.state.buildLog;

				this.setState({ ...this.state, steps, files, buildLog });
			};

			const result = await buildProject(
				{ AI: this.env.AI, Sandbox: this.env.Sandbox },
				spec,
				onStep,
			);

			// Build final files object from result
			const filesObj: Record<string, string> = {};
			for (const [path, content] of result.files) {
				filesObj[path] = content;
			}

			this.setState({
				...this.state,
				files: filesObj,
				buildLog: result.buildLog || this.state.buildLog,
				status: "complete",
			});

			// Persist to D1
			await this.persistFiles(spawn.id, spec, result.files, result.buildLog);

			await db
				.update(spawns)
				.set({
					status: "complete",
					buildLog: result.buildLog || null,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(spawns.id, spawn.id));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.setState({ ...this.state, status: "failed", error: message });

			if (this.state.spawnId) {
				const db = drizzle(this.env.DB);
				await db
					.update(spawns)
					.set({ status: "failed", error: message, updatedAt: new Date().toISOString() })
					.where(eq(spawns.id, this.state.spawnId));
			}
		}
	}

	private async retrySpawn() {
		const prompt = this.state.prompt;
		if (!prompt) return;

		// Delete existing D1 records if present
		if (this.state.spawnId) {
			const db = drizzle(this.env.DB);
			await db.delete(spawnFiles).where(eq(spawnFiles.spawnId, this.state.spawnId));
			await db.delete(spawns).where(eq(spawns.id, this.state.spawnId));
		}

		// Reset state and re-run with the same prompt
		await this.startSpawn(prompt);
	}

	private async continueWithFeedback(feedback: string) {
		if (!this.state.spec) return;

		this.setState({
			...this.state,
			status: "building",
			buildLog: null,
		});

		try {
			const existingFiles = new Map(Object.entries(this.state.files));

			const onStep = (step: AgentStep) => {
				const steps = [...this.state.steps, step];
				const files = { ...this.state.files };

				if (step.toolName === "write_file" && step.toolArgs) {
					files[step.toolArgs.path as string] = step.toolArgs.content as string;
				}

				const buildLog =
					step.toolName === "exec" && step.result
						? `${this.state.buildLog ?? ""}${this.state.buildLog ? "\n\n" : ""}${step.result}`
						: this.state.buildLog;

				this.setState({ ...this.state, steps, files, buildLog });
			};

			const result = await continueProject(
				{ AI: this.env.AI, Sandbox: this.env.Sandbox },
				this.state.spec,
				existingFiles,
				feedback,
				onStep,
			);

			const filesObj: Record<string, string> = {};
			for (const [path, content] of result.files) {
				filesObj[path] = content;
			}

			this.setState({
				...this.state,
				files: filesObj,
				buildLog: result.buildLog || this.state.buildLog,
				status: "complete",
			});

			// Update D1
			if (this.state.spawnId) {
				await this.persistFiles(this.state.spawnId, this.state.spec, result.files, result.buildLog);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.setState({ ...this.state, status: "failed", error: message });
		}
	}

	private async persistFiles(
		spawnId: string,
		spec: SpecResult,
		files: Map<string, string>,
		buildLog: string | null,
	) {
		const db = drizzle(this.env.DB);

		for (const [path, content] of files) {
			const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
			await db
				.insert(spawnFiles)
				.values({ spawnId, path, content, language: ext })
				.onConflictDoUpdate({
					target: [spawnFiles.spawnId, spawnFiles.path],
					set: { content },
				});
		}

		// Update spawn record with build log
		await db
			.update(spawns)
			.set({
				status: "complete",
				buildLog: buildLog || null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(spawns.id, spawnId));

		// Store manifest in R2
		const manifest = {
			name: spec.name,
			description: spec.description,
			platform: spec.platform,
			files: [...files.keys()],
			updatedAt: new Date().toISOString(),
		};
		await this.env.STORAGE.put(
			`spawns/${spawnId}/manifest.json`,
			JSON.stringify(manifest, null, 2),
		);
	}
}
