/// <reference types="../../worker-configuration.d.ts" />

import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { getSandbox } from "@cloudflare/sandbox";
import type { Connection } from "agents";
import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SpawnAgentState, SpecResult } from "../../src/shared/schemas";
import { spawnFiles, spawns } from "../db/schema";
import {
	buildProjectStream,
	continueProjectStream,
	createSandbox,
	extractSpec,
	seedSandbox,
} from "../services/spawn-engine";

export type { SpawnAgentState } from "../../src/shared/schemas";

// ── Hostname helper ─────────────────────────────────────────────────────

function getHostname(env: Cloudflare.Env): string {
	const name =
		(env as unknown as Record<string, string>).ENVIRONMENT === "production"
			? "netm8.com"
			: "netm8-staging.jaketdaniels95.workers.dev";
	return name;
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
		workspaceStatus: "hidden",
		previewUrl: null,
		activeFile: "",
	};

	// Keep sandbox alive across phases for live preview
	private activeSandbox: ReturnType<typeof getSandbox> | null = null;

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
				return new Response(summary);
			}

			// Phase 2: Spec exists, awaiting approval
			if (this.state.status === "awaiting-approval") {
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
			this.setState({
				...this.state,
				status: "failed",
				error: message,
				workspaceStatus: "logs",
			});

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
		this.setState({
			...this.state,
			status: "extracting-spec",
			error: null,
			workspaceStatus: "hidden",
		});
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
			workspaceStatus: "code",
		});

		return spec.summary;
	}

	// ── Spec Revision (rejected → re-extract with feedback) ─────────────

	private async handleSpecRevision(feedback: string): Promise<Response> {
		if (this.state.spawnId) {
			const db = drizzle(this.env.DB);
			await db.delete(spawnFiles).where(eq(spawnFiles.spawnId, this.state.spawnId));
			await db.delete(spawns).where(eq(spawns.id, this.state.spawnId));
		}

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

		// Destroy any previous sandbox before creating a new one
		await this.destroySandbox();
		const sandbox = createSandbox({ Sandbox: this.env.Sandbox });
		this.activeSandbox = sandbox;

		this.setState({
			...this.state,
			status: "building",
			completedFeatures: 0,
			workspaceStatus: "code",
			previewUrl: null,
			activeFile: "",
		});

		const files = new Map<string, string>();

		const onFileWrite = (path: string, content: string) => {
			const newFiles = { ...this.state.files, [path]: content };
			const fileCount = Object.keys(newFiles).length;
			const completed = Math.min(
				Math.floor((fileCount / Math.max(fileCount + 2, featureCount)) * featureCount),
				featureCount - 1,
			);
			this.setState({
				...this.state,
				files: newFiles,
				completedFeatures: completed,
				activeFile: path,
			});
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
							workspaceStatus: "code",
						});
						await this.persistFiles(spawnId, spec, files, buildLog);
						await db
							.update(spawns)
							.set({ status: "complete", buildLog, updatedAt: new Date().toISOString() })
							.where(eq(spawns.id, spawnId));

						// Try to start dev server and expose preview
						await this.tryExposePreview(sandbox, filesObj);
					} else {
						const modelOutput = buildLog ? buildLog.slice(0, 500) : "(empty)";
						const errorMsg = `Build produced no files. Model output: ${modelOutput}`;
						this.setState({
							...this.state,
							status: "failed",
							error: errorMsg,
							workspaceStatus: "logs",
						});
						await db
							.update(spawns)
							.set({
								status: "failed",
								error: errorMsg,
								updatedAt: new Date().toISOString(),
							})
							.where(eq(spawns.id, spawnId));
						await this.destroySandbox();
					}
				} catch (err) {
					console.error("Failed to persist build results:", err);
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
		this.setState({
			...this.state,
			status: "building",
			error: null,
			completedFeatures: 0,
			workspaceStatus: "code",
			previewUrl: null,
		});

		// Destroy previous sandbox, create fresh one seeded with existing files
		await this.destroySandbox();
		const sandbox = createSandbox({ Sandbox: this.env.Sandbox });
		this.activeSandbox = sandbox;
		const existingFiles = new Map(Object.entries(this.state.files));
		const files = new Map(existingFiles);

		await seedSandbox(sandbox, existingFiles);

		const onFileWrite = (path: string, content: string) => {
			const newFiles = { ...this.state.files, [path]: content };
			const fileCount = Object.keys(newFiles).length;
			const completed = Math.min(
				Math.floor((fileCount / Math.max(fileCount + 2, featureCount)) * featureCount),
				featureCount - 1,
			);
			this.setState({
				...this.state,
				files: newFiles,
				completedFeatures: completed,
				activeFile: path,
			});
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
							workspaceStatus: "code",
						});
						if (this.state.spawnId) {
							await this.persistFiles(this.state.spawnId, this.state.spec!, files, buildLog);
						}
						await this.tryExposePreview(sandbox, filesObj);
					} else {
						const modelOutput = buildLog ? buildLog.slice(0, 500) : "(empty)";
						this.setState({
							...this.state,
							status: "failed",
							error: `Build produced no files. Model output: ${modelOutput}`,
							workspaceStatus: "logs",
						});
						await this.destroySandbox();
					}
				} catch (err) {
					console.error("Failed to persist feedback results:", err);
				}

				onFinish(event as Parameters<StreamTextOnFinishCallback<ToolSet>>[0]);
			},
		);

		return result.toUIMessageStreamResponse();
	}

	// ── Preview (start dev server + expose port) ────────────────────────

	private async tryExposePreview(
		sandbox: ReturnType<typeof getSandbox>,
		filesObj: Record<string, string>,
	) {
		try {
			// Determine if project has a dev server by checking package.json scripts
			const pkgJson = filesObj["package.json"];
			if (!pkgJson) return;

			const pkg = JSON.parse(pkgJson) as { scripts?: Record<string, string> };
			const scripts = pkg.scripts ?? {};
			const devCmd = scripts.dev ?? scripts.start;
			if (!devCmd) return;

			// Detect port from common patterns: --port 3000, -p 3000, PORT=3000
			const portMatch = devCmd.match(/(?:--port|PORT=|-p)\s*(\d+)/);
			const port = portMatch ? Number.parseInt(portMatch[1], 10) : 3000;

			console.log(
				`[preview] Starting dev server: ${scripts.dev ? "npm run dev" : "npm start"} on port ${port}`,
			);

			const proc = await sandbox.startProcess(scripts.dev ? "npm run dev" : "npm start", {
				cwd: "/workspace",
			});
			await proc.waitForPort(port, { mode: "tcp" });

			const hostname = getHostname(this.env);
			const { url } = await sandbox.exposePort(port, { hostname });

			console.log(`[preview] Preview URL: ${url}`);
			this.setState({
				...this.state,
				previewUrl: url,
				workspaceStatus: "preview",
			});
		} catch (err) {
			// Preview is best-effort — don't fail the build if it doesn't work
			console.error("[preview] Failed to start preview:", err instanceof Error ? err.message : err);
		}
	}

	// ── Reset (retry) ───────────────────────────────────────────────────

	private async handleReset() {
		await this.destroySandbox();

		if (this.state.spawnId) {
			const db = drizzle(this.env.DB);
			await db.delete(spawnFiles).where(eq(spawnFiles.spawnId, this.state.spawnId));
			await db.delete(spawns).where(eq(spawns.id, this.state.spawnId));
		}

		this.setState(this.initialState);
		await this.persistMessages([]);
	}

	// ── Sandbox lifecycle ───────────────────────────────────────────────

	private async destroySandbox() {
		if (this.activeSandbox) {
			try {
				await this.activeSandbox.destroy();
			} catch (err) {
				console.error("[sandbox] Failed to destroy:", err instanceof Error ? err.message : err);
			}
			this.activeSandbox = null;
		}
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
