/// <reference types="../../worker-configuration.d.ts" />

import { Agent, type Connection } from "agents";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SpecResult } from "../../src/shared/schemas";
import { spawnFiles, spawns } from "../db/schema";
import {
	applyOperations,
	type EmitFn,
	executeSpawnLoop,
	extractSpec,
	runIteration,
} from "../services/spawn-engine";

// ── State ───────────────────────────────────────────────────────────────

interface IterationSummary {
	iteration: number;
	reasoning: string;
	created: string[];
	edited: string[];
	deleted: string[];
}

export interface SpawnAgentState {
	spawnId: string | null;
	prompt: string | null;
	status: "idle" | "running" | "complete" | "failed";
	spec: SpecResult | null;
	iteration: number;
	iterations: IterationSummary[];
	files: Record<string, string>;
	totalFiles: number;
	error: string | null;
	summary: string | null;
}

// ── Agent ───────────────────────────────────────────────────────────────

export class SpawnAgent extends Agent<Cloudflare.Env, SpawnAgentState> {
	initialState: SpawnAgentState = {
		spawnId: null,
		prompt: null,
		status: "idle",
		spec: null,
		iteration: 0,
		iterations: [],
		files: {},
		totalFiles: 0,
		error: null,
		summary: null,
	};

	async onMessage(_connection: Connection, message: string) {
		const data = JSON.parse(message);

		switch (data.type) {
			case "spawn":
				if (this.state.status !== "running") {
					await this.startSpawn(data.prompt);
				}
				break;

			case "feedback":
				if (this.state.status === "complete") {
					// Re-open the loop with user feedback
					await this.continueWithFeedback(data.prompt);
				}
				break;
		}
	}

	private async startSpawn(prompt: string) {
		this.setState({
			...this.initialState,
			prompt,
			status: "running",
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

			this.setState({ ...this.state, spawnId: spawn.id, spec });

			// 2. Run iterative build loop
			const emit: EmitFn = async (event, data) => {
				if (event === "iteration:start") {
					const d = data as { iteration: number };
					this.setState({ ...this.state, iteration: d.iteration });
				} else if (event === "iteration:complete") {
					const d = data as IterationSummary & {
						isDone: boolean;
						summary: string | null;
						totalFiles: number;
					};
					const iterSummary: IterationSummary = {
						iteration: d.iteration,
						reasoning: d.reasoning,
						created: d.created,
						edited: d.edited,
						deleted: d.deleted,
					};
					this.setState({
						...this.state,
						iterations: [...this.state.iterations, iterSummary],
						totalFiles: d.totalFiles,
						summary: d.summary,
						status: d.isDone ? "complete" : "running",
					});
				}
			};

			const finalFiles = await executeSpawnLoop(this.env.AI, spec, emit);

			// Persist files to D1 + R2
			await this.persistFiles(spawn.id, spec, finalFiles);

			// Update final state with all file contents
			const filesObj: Record<string, string> = {};
			for (const [path, content] of finalFiles) {
				filesObj[path] = content;
			}

			this.setState({
				...this.state,
				files: filesObj,
				totalFiles: finalFiles.size,
				status: "complete",
			});

			await db
				.update(spawns)
				.set({ status: "complete", updatedAt: new Date().toISOString() })
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

	private async continueWithFeedback(feedback: string) {
		if (!this.state.spec) return;

		this.setState({ ...this.state, status: "running", summary: null });

		try {
			// Rebuild file map from state
			const files = new Map(Object.entries(this.state.files));
			const nextIteration = this.state.iteration + 1;

			const result = await runIteration(
				this.env.AI,
				this.state.spec,
				files,
				nextIteration,
				feedback,
			);
			const { created, edited, deleted } = applyOperations(files, result.operations);
			const isDone = result.operations.some((op) => op.op === "done");
			const doneSummary = result.operations.find((op) => op.op === "done");

			const filesObj: Record<string, string> = {};
			for (const [path, content] of files) {
				filesObj[path] = content;
			}

			const iterSummary: IterationSummary = {
				iteration: nextIteration,
				reasoning: result.reasoning,
				created,
				edited,
				deleted,
			};

			this.setState({
				...this.state,
				iteration: nextIteration,
				iterations: [...this.state.iterations, iterSummary],
				files: filesObj,
				totalFiles: files.size,
				status: isDone ? "complete" : "complete", // stays complete, user can send more feedback
				summary: isDone && doneSummary?.op === "done" ? doneSummary.summary : result.reasoning,
			});

			// Update D1
			if (this.state.spawnId) {
				await this.persistFiles(this.state.spawnId, this.state.spec, files);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.setState({ ...this.state, status: "failed", error: message });
		}
	}

	private async persistFiles(spawnId: string, spec: SpecResult, files: Map<string, string>) {
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
