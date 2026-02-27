/// <reference types="../../worker-configuration.d.ts" />

import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { Connection } from "agents";
import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SpecResult } from "../../src/shared/schemas";
import { spawnFiles, spawns } from "../db/schema";
import {
	buildProjectStream,
	continueProjectStream,
	createSandbox,
	extractSpec,
	seedSandbox,
} from "../services/spawn-engine";

// ── State ───────────────────────────────────────────────────────────────

export interface SpawnAgentState {
	spawnId: string | null;
	spec: SpecResult | null;
	files: Record<string, string>;
	status: "idle" | "extracting-spec" | "building" | "complete" | "failed";
	error: string | null;
}

// ── Agent ───────────────────────────────────────────────────────────────

export class SpawnAgent extends AIChatAgent<Cloudflare.Env, SpawnAgentState> {
	initialState: SpawnAgentState = {
		spawnId: null,
		spec: null,
		files: {},
		status: "idle",
		error: null,
	};

	async onChatMessage(
		onFinish: StreamTextOnFinishCallback<ToolSet>,
		_options?: OnChatMessageOptions,
	): Promise<Response | undefined> {
		const userText = this.getLastUserText();
		if (!userText) return undefined;

		try {
			if (!this.state.spec) {
				return await this.handleBuild(userText, onFinish);
			}
			return await this.handleFeedback(userText, onFinish);
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

			return undefined;
		}
	}

	async onMessage(connection: Connection, message: string) {
		try {
			const data = JSON.parse(message);
			if (data.type === "reset") {
				await this.handleReset();
				return;
			}
		} catch {
			// Not JSON — fall through to default chat protocol handling
		}
		super.onMessage(connection, message);
	}

	// ── Build (first message) ───────────────────────────────────────────

	private async handleBuild(
		prompt: string,
		onFinish: StreamTextOnFinishCallback<ToolSet>,
	): Promise<Response> {
		// 1. Extract spec
		this.setState({ ...this.state, status: "extracting-spec", error: null });
		const spec = await extractSpec(this.env.AI, prompt);

		// 2. Create D1 record
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

		// 3. Create sandbox and stream build
		const sandbox = createSandbox({ Sandbox: this.env.Sandbox });
		const files = new Map<string, string>();

		const onFileWrite = (path: string, content: string) => {
			this.setState({ ...this.state, files: { ...this.state.files, [path]: content } });
		};

		const result = buildProjectStream(
			{ AI: this.env.AI },
			spec,
			sandbox,
			files,
			onFileWrite,
			async (event) => {
				try {
					const filesObj: Record<string, string> = {};
					for (const [path, content] of files) {
						filesObj[path] = content;
					}

					const buildLog = this.extractBuildLog(event);
					this.setState({ ...this.state, files: filesObj, status: "complete" });

					await this.persistFiles(spawn.id, spec, files, buildLog);
					await db
						.update(spawns)
						.set({ status: "complete", buildLog, updatedAt: new Date().toISOString() })
						.where(eq(spawns.id, spawn.id));
				} catch (err) {
					console.error("Failed to persist build results:", err);
				} finally {
					await sandbox.destroy();
				}

				onFinish(event as Parameters<StreamTextOnFinishCallback<ToolSet>>[0]);
			},
		);

		return result.toUIMessageStreamResponse();
	}

	// ── Feedback (subsequent messages) ──────────────────────────────────

	private async handleFeedback(
		feedback: string,
		onFinish: StreamTextOnFinishCallback<ToolSet>,
	): Promise<Response> {
		this.setState({ ...this.state, status: "building", error: null });

		const sandbox = createSandbox({ Sandbox: this.env.Sandbox });
		const existingFiles = new Map(Object.entries(this.state.files));
		const files = new Map(existingFiles);

		// Seed sandbox with existing files
		await seedSandbox(sandbox, existingFiles);

		const onFileWrite = (path: string, content: string) => {
			this.setState({ ...this.state, files: { ...this.state.files, [path]: content } });
		};

		const result = continueProjectStream(
			{ AI: this.env.AI },
			this.state.spec!,
			sandbox,
			files,
			feedback,
			onFileWrite,
			async (event) => {
				try {
					const filesObj: Record<string, string> = {};
					for (const [path, content] of files) {
						filesObj[path] = content;
					}

					const buildLog = this.extractBuildLog(event);
					this.setState({ ...this.state, files: filesObj, status: "complete" });

					if (this.state.spawnId) {
						await this.persistFiles(this.state.spawnId, this.state.spec!, files, buildLog);
					}
				} catch (err) {
					console.error("Failed to persist feedback results:", err);
				} finally {
					await sandbox.destroy();
				}

				onFinish(event as Parameters<StreamTextOnFinishCallback<ToolSet>>[0]);
			},
		);

		return result.toUIMessageStreamResponse();
	}

	// ── Reset (retry) ───────────────────────────────────────────────────

	private async handleReset() {
		if (this.state.spawnId) {
			const db = drizzle(this.env.DB);
			await db.delete(spawnFiles).where(eq(spawnFiles.spawnId, this.state.spawnId));
			await db.delete(spawns).where(eq(spawns.id, this.state.spawnId));
		}

		this.setState(this.initialState);
		await this.persistMessages([]);
	}

	// ── Helpers ─────────────────────────────────────────────────────────

	private getLastUserText(): string {
		const last = this.messages.filter((m) => m.role === "user").at(-1);
		if (!last) return "";
		const textPart = last.parts.find((p) => p.type === "text");
		return textPart && "text" in textPart ? textPart.text : "";
	}

	private extractBuildLog(event: { text: string }): string | null {
		// The event.text contains the final text output from the model
		// For a richer build log, we could parse tool results, but the text summary suffices for D1
		return event.text || null;
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
