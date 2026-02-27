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
	status: "idle" | "extracting-spec" | "awaiting-approval" | "building" | "complete" | "failed";
	error: string | null;
	completedFeatures: number;
}

// ── Agent ───────────────────────────────────────────────────────────────

export class SpawnAgent extends AIChatAgent<Cloudflare.Env, SpawnAgentState> {
	initialState: SpawnAgentState = {
		spawnId: null,
		spec: null,
		files: {},
		status: "idle",
		error: null,
		completedFeatures: 0,
	};

	async onChatMessage(
		onFinish: StreamTextOnFinishCallback<ToolSet>,
		_options?: OnChatMessageOptions,
	): Promise<Response | undefined> {
		const userText = this.getLastUserText();
		if (!userText) return undefined;

		try {
			// Phase 1: No spec yet → extract it, park at awaiting-approval
			if (!this.state.spec) {
				const summary = await this.handleSpecExtraction(userText);
				// Return the model-generated summary as a plaintext response.
				// This properly closes the chat protocol cycle (returning undefined
				// leaves useAgentChat status stuck) and gives the user a natural
				// language explanation of the extracted spec.
				return new Response(summary);
			}

			// Phase 2: Spec exists, awaiting approval
			if (this.state.status === "awaiting-approval") {
				// "approved" → start building; anything else → re-extract spec with feedback
				if (userText.toLowerCase().trim() === "approved") {
					return await this.handleBuild(onFinish);
				}
				return await this.handleSpecRevision(userText);
			}

			// Phase 3: Build complete → apply feedback
			return await this.handleFeedback(userText, onFinish);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[agent] onChatMessage error:", message, err instanceof Error ? err.stack : "");
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

	// ── Spec Extraction (phase 1) ────────────────────────────────────────

	private async handleSpecExtraction(prompt: string): Promise<string> {
		this.setState({ ...this.state, status: "extracting-spec", error: null });
		const spec = await extractSpec(this.env.AI, prompt);

		const db = drizzle(this.env.DB);
		const [spawn] = await db
			.insert(spawns)
			.values({
				prompt,
				name: spec.name,
				description: spec.description,
				platform: spec.platform,
				features: JSON.stringify(spec.features),
				status: "pending",
			})
			.returning();

		this.setState({
			...this.state,
			spawnId: spawn.id,
			spec,
			status: "awaiting-approval",
		});

		return spec.summary;
	}

	// ── Spec Revision (rejected → re-extract with feedback) ─────────────

	private async handleSpecRevision(feedback: string): Promise<Response> {
		// Delete the old spawn record
		if (this.state.spawnId) {
			const db = drizzle(this.env.DB);
			await db.delete(spawnFiles).where(eq(spawnFiles.spawnId, this.state.spawnId));
			await db.delete(spawns).where(eq(spawns.id, this.state.spawnId));
		}

		// Combine original prompt with revision feedback
		const originalPrompt = this.getFirstUserText();
		const revisedPrompt = originalPrompt
			? `${originalPrompt}\n\nRevisions requested: ${feedback}`
			: feedback;

		const summary = await this.handleSpecExtraction(revisedPrompt);
		return new Response(summary);
	}

	// ── Build (phase 2 — after approval) ─────────────────────────────────

	private async handleBuild(onFinish: StreamTextOnFinishCallback<ToolSet>): Promise<Response> {
		const spec = this.state.spec!;
		const spawnId = this.state.spawnId!;
		const featureCount = spec.features.length;

		const db = drizzle(this.env.DB);
		await db
			.update(spawns)
			.set({ status: "running", updatedAt: new Date().toISOString() })
			.where(eq(spawns.id, spawnId));

		this.setState({ ...this.state, status: "building", completedFeatures: 0 });

		const sandbox = createSandbox({ Sandbox: this.env.Sandbox });
		const files = new Map<string, string>();

		const onFileWrite = (path: string, content: string) => {
			const newFiles = { ...this.state.files, [path]: content };
			const fileCount = Object.keys(newFiles).length;
			const completed = Math.min(
				Math.floor((fileCount / Math.max(fileCount + 2, featureCount)) * featureCount),
				featureCount - 1,
			);
			this.setState({ ...this.state, files: newFiles, completedFeatures: completed });
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

					if (files.size > 0) {
						this.setState({
							...this.state,
							files: filesObj,
							status: "complete",
							completedFeatures: featureCount,
						});
						await this.persistFiles(spawnId, spec, files, buildLog);
						await db
							.update(spawns)
							.set({ status: "complete", buildLog, updatedAt: new Date().toISOString() })
							.where(eq(spawns.id, spawnId));
					} else {
						this.setState({
							...this.state,
							status: "failed",
							error: "Build produced no files — the model may have hit its token limit",
						});
						await db
							.update(spawns)
							.set({
								status: "failed",
								error: "No files generated",
								updatedAt: new Date().toISOString(),
							})
							.where(eq(spawns.id, spawnId));
					}
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
		const featureCount = this.state.spec?.features.length ?? 0;
		this.setState({ ...this.state, status: "building", error: null, completedFeatures: 0 });

		const sandbox = createSandbox({ Sandbox: this.env.Sandbox });
		const existingFiles = new Map(Object.entries(this.state.files));
		const files = new Map(existingFiles);

		// Seed sandbox with existing files
		await seedSandbox(sandbox, existingFiles);

		const onFileWrite = (path: string, content: string) => {
			const newFiles = { ...this.state.files, [path]: content };
			const fileCount = Object.keys(newFiles).length;
			const completed = Math.min(
				Math.floor((fileCount / Math.max(fileCount + 2, featureCount)) * featureCount),
				featureCount - 1,
			);
			this.setState({ ...this.state, files: newFiles, completedFeatures: completed });
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

					if (files.size > 0) {
						this.setState({
							...this.state,
							files: filesObj,
							status: "complete",
							completedFeatures: featureCount,
						});
						if (this.state.spawnId) {
							await this.persistFiles(this.state.spawnId, this.state.spec!, files, buildLog);
						}
					} else {
						this.setState({
							...this.state,
							status: "failed",
							error: "Build produced no files — the model may have hit its token limit",
						});
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

	private getFirstUserText(): string {
		const first = this.messages.find((m) => m.role === "user");
		if (!first) return "";
		const textPart = first.parts.find((p) => p.type === "text");
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
