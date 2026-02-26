import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { SpawnStageName } from "../shared/schemas";

// ── Types ───────────────────────────────────────────────────────────────

interface SpawnEvent {
	event: string;
	data: unknown;
	timestamp: number;
}

interface FileEvent {
	path: string;
	language: string;
	size: number;
	index: number;
	total: number;
}

interface SeedData {
	name: string;
	description: string;
	platform: string;
	features: string[];
}

interface SproutData {
	files: Array<{ path: string; language: string; purpose: string }>;
	techStack: Record<string, string>;
	entryPoint: string;
}

interface BloomData {
	fixes: Array<{ path: string; issue: string }>;
	summary: string;
}

interface HarvestData {
	totalFiles: number;
	archiveKey: string;
}

// ── Route ───────────────────────────────────────────────────────────────

export const Route = createFileRoute("/spawn")({
	component: SpawnPage,
});

// ── Constants ───────────────────────────────────────────────────────────

const STAGE_META: Record<SpawnStageName, { label: string; icon: string; color: string }> = {
	seed: { label: "Seed", icon: "\u{1F331}", color: "#8B7355" },
	sprout: { label: "Sprout", icon: "\u{1FAB4}", color: "#6B8E23" },
	grow: { label: "Grow", icon: "\u{1F333}", color: "#228B22" },
	bloom: { label: "Bloom", icon: "\u{1F338}", color: "#FF69B4" },
	harvest: { label: "Harvest", icon: "\u{1F33E}", color: "#DAA520" },
};

const STAGES: SpawnStageName[] = ["seed", "sprout", "grow", "bloom", "harvest"];

// ── Component ───────────────────────────────────────────────────────────

function SpawnPage() {
	const [prompt, setPrompt] = useState("");
	const [isRunning, setIsRunning] = useState(false);
	const [currentStage, setCurrentStage] = useState<SpawnStageName | null>(null);
	const [spawnId, setSpawnId] = useState<string | null>(null);
	const [events, setEvents] = useState<SpawnEvent[]>([]);
	const [seed, setSeed] = useState<SeedData | null>(null);
	const [sprout, setSprout] = useState<SproutData | null>(null);
	const [filesProgress, setFilesProgress] = useState<FileEvent[]>([]);
	const [bloom, setBloom] = useState<BloomData | null>(null);
	const [harvest, setHarvest] = useState<HarvestData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [completedStages, setCompletedStages] = useState<Set<SpawnStageName>>(new Set());

	const addEvent = useCallback((event: string, data: unknown) => {
		setEvents((prev) => [...prev, { event, data, timestamp: Date.now() }]);
	}, []);

	const handleSpawn = async () => {
		if (!prompt.trim() || isRunning) return;

		setIsRunning(true);
		setError(null);
		setEvents([]);
		setSeed(null);
		setSprout(null);
		setFilesProgress([]);
		setBloom(null);
		setHarvest(null);
		setCurrentStage(null);
		setCompletedStages(new Set());

		try {
			const res = await fetch("/api/spawns", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt }),
			});

			if (!res.ok || !res.body) {
				throw new Error(`Spawn failed: ${res.status}`);
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				let currentEvent = "";
				for (const line of lines) {
					if (line.startsWith("event:")) {
						currentEvent = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						const raw = line.slice(5).trim();
						try {
							const data = JSON.parse(raw);
							addEvent(currentEvent, data);
							processEvent(currentEvent, data);
						} catch {
							addEvent(currentEvent, raw);
						}
					}
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setError(msg);
			addEvent("error", { error: msg });
		} finally {
			setIsRunning(false);
		}
	};

	const processEvent = (event: string, data: unknown) => {
		switch (event) {
			case "init": {
				const d = data as { spawnId: string };
				setSpawnId(d.spawnId);
				break;
			}
			case "stage": {
				const d = data as { stage: SpawnStageName; status: string };
				setCurrentStage(d.stage);
				break;
			}
			case "seed": {
				setSeed(data as SeedData);
				setCompletedStages((prev) => new Set([...prev, "seed"]));
				break;
			}
			case "sprout": {
				setSprout(data as SproutData);
				setCompletedStages((prev) => new Set([...prev, "sprout"]));
				break;
			}
			case "file": {
				const d = data as FileEvent;
				setFilesProgress((prev) => [...prev, d]);
				if (d.index === d.total) {
					setCompletedStages((prev) => new Set([...prev, "grow"]));
				}
				break;
			}
			case "bloom": {
				setBloom(data as BloomData);
				setCompletedStages((prev) => new Set([...prev, "bloom"]));
				break;
			}
			case "harvest": {
				setHarvest(data as HarvestData);
				setCompletedStages((prev) => new Set([...prev, "harvest"]));
				break;
			}
			case "complete":
				setCurrentStage(null);
				break;
			case "error": {
				const d = data as { error: string };
				setError(d.error);
				break;
			}
		}
	};

	return (
		<div style={styles.container}>
			<header style={styles.header}>
				<a href="/" style={styles.backLink}>
					netm8
				</a>
				<h1 style={styles.title}>spawn</h1>
				<p style={styles.subtitle}>Describe software. Watch it grow.</p>
			</header>

			{/* Input */}
			<div style={styles.inputSection}>
				<textarea
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder="Describe the software you want to create..."
					style={styles.textarea}
					rows={3}
					disabled={isRunning}
					onKeyDown={(e) => {
						if (e.key === "Enter" && e.metaKey) handleSpawn();
					}}
				/>
				<button
					type="button"
					onClick={handleSpawn}
					disabled={isRunning || !prompt.trim()}
					style={{
						...styles.button,
						opacity: isRunning || !prompt.trim() ? 0.5 : 1,
					}}
				>
					{isRunning ? "Growing..." : "Spawn"}
				</button>
			</div>

			{/* Stage Pipeline */}
			{(isRunning || spawnId) && (
				<div style={styles.pipeline}>
					{STAGES.map((stage, i) => {
						const meta = STAGE_META[stage];
						const isActive = currentStage === stage;
						const isDone = completedStages.has(stage);
						return (
							<div key={stage} style={styles.pipelineItem}>
								{i > 0 && (
									<div
										style={{
											...styles.pipelineConnector,
											backgroundColor: isDone ? meta.color : "#333",
										}}
									/>
								)}
								<div
									style={{
										...styles.stageChip,
										borderColor: isActive ? meta.color : isDone ? meta.color : "#333",
										backgroundColor: isDone ? `${meta.color}22` : "transparent",
										boxShadow: isActive ? `0 0 12px ${meta.color}66` : "none",
									}}
								>
									<span>{meta.icon}</span>
									<span style={{ color: isDone || isActive ? meta.color : "#666" }}>
										{meta.label}
									</span>
									{isActive && <span style={styles.pulse} />}
								</div>
							</div>
						);
					})}
				</div>
			)}

			{/* Error */}
			{error && (
				<div style={styles.errorBox}>
					<strong>Error:</strong> {error}
				</div>
			)}

			{/* Seed Result */}
			{seed && (
				<div style={styles.card}>
					<h3 style={styles.cardTitle}>
						{STAGE_META.seed.icon} {seed.name}
					</h3>
					<p style={styles.cardDesc}>{seed.description}</p>
					<div style={styles.tags}>
						<span style={styles.tag}>{seed.platform}</span>
						{seed.features.map((f) => (
							<span key={f} style={styles.tag}>
								{f}
							</span>
						))}
					</div>
				</div>
			)}

			{/* Sprout Result */}
			{sprout && (
				<div style={styles.card}>
					<h3 style={styles.cardTitle}>{STAGE_META.sprout.icon} Architecture</h3>
					<div style={styles.techStack}>
						{Object.entries(sprout.techStack).map(([k, v]) => (
							<span key={k} style={styles.techTag}>
								{k}: {v}
							</span>
						))}
					</div>
					<div style={styles.fileTree}>
						{sprout.files.map((f) => (
							<div key={f.path} style={styles.fileTreeItem}>
								<code style={styles.filePath}>{f.path}</code>
								<span style={styles.filePurpose}>{f.purpose}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Grow Progress */}
			{filesProgress.length > 0 && (
				<div style={styles.card}>
					<h3 style={styles.cardTitle}>
						{STAGE_META.grow.icon} Code Generation{" "}
						<span style={styles.counter}>
							{filesProgress.length}/{filesProgress[0]?.total ?? "?"}
						</span>
					</h3>
					<div style={styles.progressBar}>
						<div
							style={{
								...styles.progressFill,
								width: `${(filesProgress.length / (filesProgress[0]?.total ?? 1)) * 100}%`,
							}}
						/>
					</div>
					<div style={styles.fileList}>
						{filesProgress.map((f) => (
							<div key={f.path} style={styles.fileGenerated}>
								<code>{f.path}</code>
								<span style={styles.fileSize}>{f.size} chars</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Bloom Result */}
			{bloom && (
				<div style={styles.card}>
					<h3 style={styles.cardTitle}>{STAGE_META.bloom.icon} Review</h3>
					<p style={styles.cardDesc}>{bloom.summary}</p>
					{bloom.fixes.length > 0 && (
						<div style={styles.fixList}>
							{bloom.fixes.map((f) => (
								<div key={`${f.path}-${f.issue}`} style={styles.fixItem}>
									<code>{f.path}</code>: {f.issue}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* Harvest Result */}
			{harvest && (
				<div style={styles.card}>
					<h3 style={styles.cardTitle}>{STAGE_META.harvest.icon} Complete</h3>
					<p style={styles.cardDesc}>{harvest.totalFiles} files generated and stored.</p>
					{spawnId && (
						<a href={`/spawns/${spawnId}`} style={styles.viewLink}>
							View project &rarr;
						</a>
					)}
				</div>
			)}

			{/* Event Log */}
			{events.length > 0 && (
				<details style={styles.logSection}>
					<summary style={styles.logSummary}>Event log ({events.length})</summary>
					<div style={styles.log}>
						{events.map((e, i) => (
							<div key={`${e.timestamp}-${i}`} style={styles.logEntry}>
								<span style={styles.logEvent}>{e.event}</span>
								<span style={styles.logData}>
									{typeof e.data === "string" ? e.data : JSON.stringify(e.data)}
								</span>
							</div>
						))}
					</div>
				</details>
			)}
		</div>
	);
}

// ── Styles ──────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
	container: {
		maxWidth: 800,
		margin: "0 auto",
		padding: "2rem",
		fontFamily: "system-ui, -apple-system, sans-serif",
		color: "#e0e0e0",
		backgroundColor: "#0a0a0a",
		minHeight: "100vh",
	},
	header: { marginBottom: "2rem" },
	backLink: {
		color: "#666",
		textDecoration: "none",
		fontSize: "0.85rem",
	},
	title: {
		fontSize: "2.5rem",
		fontWeight: 700,
		margin: "0.25rem 0",
		background: "linear-gradient(135deg, #6B8E23, #228B22, #DAA520)",
		WebkitBackgroundClip: "text",
		WebkitTextFillColor: "transparent",
	},
	subtitle: { color: "#888", margin: 0 },
	inputSection: { display: "flex", gap: "0.75rem", marginBottom: "2rem" },
	textarea: {
		flex: 1,
		padding: "0.75rem 1rem",
		backgroundColor: "#111",
		border: "1px solid #333",
		borderRadius: 8,
		color: "#e0e0e0",
		fontSize: "1rem",
		fontFamily: "inherit",
		resize: "vertical",
		outline: "none",
	},
	button: {
		padding: "0.75rem 2rem",
		backgroundColor: "#228B22",
		color: "#fff",
		border: "none",
		borderRadius: 8,
		fontSize: "1rem",
		fontWeight: 600,
		cursor: "pointer",
		alignSelf: "flex-end",
		whiteSpace: "nowrap",
	},
	pipeline: {
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 0,
		marginBottom: "2rem",
		flexWrap: "wrap",
	},
	pipelineItem: { display: "flex", alignItems: "center" },
	pipelineConnector: {
		width: 32,
		height: 2,
		transition: "background-color 0.3s",
	},
	stageChip: {
		display: "flex",
		alignItems: "center",
		gap: "0.35rem",
		padding: "0.4rem 0.75rem",
		border: "1px solid",
		borderRadius: 20,
		fontSize: "0.85rem",
		transition: "all 0.3s",
		position: "relative" as const,
	},
	pulse: {
		width: 6,
		height: 6,
		borderRadius: "50%",
		backgroundColor: "#4CAF50",
		animation: "pulse 1.5s infinite",
	},
	card: {
		backgroundColor: "#111",
		border: "1px solid #222",
		borderRadius: 12,
		padding: "1.25rem",
		marginBottom: "1rem",
	},
	cardTitle: { margin: "0 0 0.5rem", fontSize: "1.1rem" },
	cardDesc: { color: "#aaa", margin: "0 0 0.75rem" },
	tags: { display: "flex", gap: "0.5rem", flexWrap: "wrap" as const },
	tag: {
		padding: "0.2rem 0.6rem",
		backgroundColor: "#1a1a2e",
		border: "1px solid #333",
		borderRadius: 12,
		fontSize: "0.8rem",
		color: "#8B8",
	},
	techStack: { display: "flex", gap: "0.5rem", flexWrap: "wrap" as const, marginBottom: "1rem" },
	techTag: {
		padding: "0.2rem 0.6rem",
		backgroundColor: "#0d1b2a",
		border: "1px solid #234",
		borderRadius: 12,
		fontSize: "0.8rem",
		color: "#6BA3D6",
	},
	fileTree: { display: "flex", flexDirection: "column" as const, gap: "0.35rem" },
	fileTreeItem: { display: "flex", justifyContent: "space-between", alignItems: "center" },
	filePath: { fontSize: "0.85rem", color: "#DAA520" },
	filePurpose: { fontSize: "0.8rem", color: "#666" },
	progressBar: {
		height: 4,
		backgroundColor: "#222",
		borderRadius: 2,
		marginBottom: "0.75rem",
		overflow: "hidden" as const,
	},
	progressFill: {
		height: "100%",
		backgroundColor: "#228B22",
		borderRadius: 2,
		transition: "width 0.3s ease",
	},
	counter: { fontSize: "0.85rem", color: "#888", fontWeight: 400 },
	fileList: { display: "flex", flexDirection: "column" as const, gap: "0.25rem" },
	fileGenerated: {
		display: "flex",
		justifyContent: "space-between",
		fontSize: "0.85rem",
	},
	fileSize: { color: "#666", fontSize: "0.8rem" },
	fixList: { display: "flex", flexDirection: "column" as const, gap: "0.25rem" },
	fixItem: { fontSize: "0.85rem", color: "#F4A460" },
	viewLink: {
		display: "inline-block",
		marginTop: "0.5rem",
		color: "#228B22",
		textDecoration: "none",
		fontWeight: 600,
	},
	errorBox: {
		backgroundColor: "#2a0a0a",
		border: "1px solid #5a1a1a",
		borderRadius: 8,
		padding: "1rem",
		color: "#ff6b6b",
		marginBottom: "1rem",
	},
	logSection: { marginTop: "2rem" },
	logSummary: { color: "#666", cursor: "pointer", fontSize: "0.85rem" },
	log: {
		marginTop: "0.5rem",
		maxHeight: 300,
		overflow: "auto",
		backgroundColor: "#080808",
		border: "1px solid #222",
		borderRadius: 8,
		padding: "0.75rem",
		fontFamily: "monospace",
		fontSize: "0.8rem",
	},
	logEntry: { display: "flex", gap: "0.75rem", marginBottom: "0.25rem" },
	logEvent: { color: "#6BA3D6", minWidth: 60 },
	logData: { color: "#888", wordBreak: "break-all" as const },
};
