import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/spawns/$id")({
	component: SpawnDetail,
});

interface SpawnFile {
	id: string;
	path: string;
	content: string;
	language: string | null;
	stage: string;
}

interface SpawnStageRecord {
	id: string;
	stage: string;
	status: string;
	output: string | null;
	startedAt: string | null;
	completedAt: string | null;
}

interface SpawnDetail {
	id: string;
	prompt: string;
	name: string | null;
	description: string | null;
	platform: string | null;
	features: string | null;
	architecture: string | null;
	stage: string;
	status: string;
	error: string | null;
	files: SpawnFile[];
	stages: SpawnStageRecord[];
}

function SpawnDetail() {
	const { id } = Route.useParams();
	const [selectedFile, setSelectedFile] = useState<string | null>(null);

	const { data, isLoading, error } = useQuery({
		queryKey: ["spawn", id],
		queryFn: async () => {
			const res = await fetch(`/api/spawns/${id}`);
			if (!res.ok) throw new Error("Spawn not found");
			return res.json() as Promise<SpawnDetail>;
		},
	});

	if (isLoading)
		return (
			<div style={styles.container}>
				<p style={styles.muted}>Loading...</p>
			</div>
		);
	if (error)
		return (
			<div style={styles.container}>
				<p style={styles.error}>Error: {error.message}</p>
			</div>
		);
	if (!data) return null;

	const activeFile = data.files.find((f) => f.path === selectedFile) ?? data.files[0];
	const features: string[] = data.features ? JSON.parse(data.features) : [];

	return (
		<div style={styles.container}>
			<header style={styles.header}>
				<div>
					<div style={styles.breadcrumb}>
						<a href="/" style={styles.crumbLink}>
							netm8
						</a>
						<span style={styles.crumbSep}>/</span>
						<Link to="/spawns" style={styles.crumbLink}>
							spawns
						</Link>
						<span style={styles.crumbSep}>/</span>
						<span>{data.name ?? id.slice(0, 8)}</span>
					</div>
					<h1 style={styles.title}>{data.name ?? "Unnamed Project"}</h1>
					{data.description && <p style={styles.subtitle}>{data.description}</p>}
				</div>
				<span
					style={{
						...styles.statusBadge,
						backgroundColor:
							data.status === "complete"
								? "#228B2233"
								: data.status === "failed"
									? "#ff6b6b33"
									: "#DAA52033",
						color:
							data.status === "complete"
								? "#4CAF50"
								: data.status === "failed"
									? "#ff6b6b"
									: "#DAA520",
					}}
				>
					{data.status}
				</span>
			</header>

			{/* Meta */}
			<div style={styles.meta}>
				{data.platform && <span style={styles.tag}>{data.platform}</span>}
				{features.map((f) => (
					<span key={f} style={styles.featureTag}>
						{f}
					</span>
				))}
			</div>

			{data.error && (
				<div style={styles.errorBox}>
					<strong>Error:</strong> {data.error}
				</div>
			)}

			{/* Prompt */}
			<div style={styles.section}>
				<h3 style={styles.sectionTitle}>Prompt</h3>
				<p style={styles.prompt}>{data.prompt}</p>
			</div>

			{/* Stage Timeline */}
			{data.stages.length > 0 && (
				<div style={styles.section}>
					<h3 style={styles.sectionTitle}>Growth Timeline</h3>
					<div style={styles.timeline}>
						{data.stages.map((s) => (
							<div key={s.id} style={styles.timelineItem}>
								<div
									style={{
										...styles.timelineDot,
										backgroundColor:
											s.status === "complete"
												? "#4CAF50"
												: s.status === "failed"
													? "#ff6b6b"
													: "#DAA520",
									}}
								/>
								<div>
									<div style={styles.timelineStage}>{s.stage}</div>
									{s.startedAt && s.completedAt && (
										<div style={styles.timelineDuration}>
											{Math.round(
												(new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()) /
													1000,
											)}
											s
										</div>
									)}
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* File Browser */}
			{data.files.length > 0 && (
				<div style={styles.section}>
					<h3 style={styles.sectionTitle}>Files ({data.files.length})</h3>
					<div style={styles.browser}>
						<div style={styles.sidebar}>
							{data.files.map((f) => (
								<button
									key={f.path}
									type="button"
									onClick={() => setSelectedFile(f.path)}
									style={{
										...styles.fileButton,
										backgroundColor: f.path === activeFile?.path ? "#1a1a2e" : "transparent",
										borderColor: f.path === activeFile?.path ? "#334" : "transparent",
									}}
								>
									<span style={styles.fileName}>{f.path.split("/").pop()}</span>
									<span style={styles.fileLang}>{f.language}</span>
								</button>
							))}
						</div>
						<div style={styles.codePanel}>
							{activeFile && (
								<>
									<div style={styles.codePanelHeader}>
										<code style={styles.codeFilePath}>{activeFile.path}</code>
										<span style={styles.codeLang}>{activeFile.language}</span>
									</div>
									<pre style={styles.codeBlock}>
										<code>{activeFile.content}</code>
									</pre>
								</>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		maxWidth: 1100,
		margin: "0 auto",
		padding: "2rem",
		fontFamily: "system-ui, -apple-system, sans-serif",
		color: "#e0e0e0",
		backgroundColor: "#0a0a0a",
		minHeight: "100vh",
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		marginBottom: "1rem",
	},
	breadcrumb: { fontSize: "0.85rem", marginBottom: "0.5rem" },
	crumbLink: { color: "#666", textDecoration: "none" },
	crumbSep: { color: "#333", margin: "0 0.35rem" },
	title: { margin: 0, fontSize: "1.75rem", fontWeight: 700 },
	subtitle: { margin: "0.25rem 0 0", color: "#888" },
	statusBadge: {
		padding: "0.3rem 0.8rem",
		borderRadius: 12,
		fontSize: "0.8rem",
		fontWeight: 600,
		textTransform: "uppercase" as const,
	},
	meta: { display: "flex", gap: "0.5rem", flexWrap: "wrap" as const, marginBottom: "1.5rem" },
	tag: {
		padding: "0.2rem 0.6rem",
		backgroundColor: "#1a1a2e",
		border: "1px solid #333",
		borderRadius: 12,
		fontSize: "0.8rem",
		color: "#8B8",
	},
	featureTag: {
		padding: "0.2rem 0.6rem",
		backgroundColor: "#0d1b2a",
		border: "1px solid #234",
		borderRadius: 12,
		fontSize: "0.8rem",
		color: "#6BA3D6",
	},
	errorBox: {
		backgroundColor: "#2a0a0a",
		border: "1px solid #5a1a1a",
		borderRadius: 8,
		padding: "1rem",
		color: "#ff6b6b",
		marginBottom: "1.5rem",
	},
	muted: { color: "#666" },
	error: { color: "#ff6b6b" },
	section: { marginBottom: "2rem" },
	sectionTitle: { fontSize: "1rem", fontWeight: 600, color: "#aaa", marginBottom: "0.75rem" },
	prompt: {
		backgroundColor: "#111",
		border: "1px solid #222",
		borderRadius: 8,
		padding: "1rem",
		color: "#ccc",
		fontStyle: "italic",
		margin: 0,
	},
	timeline: { display: "flex", gap: "1.5rem", flexWrap: "wrap" as const },
	timelineItem: { display: "flex", alignItems: "center", gap: "0.5rem" },
	timelineDot: { width: 10, height: 10, borderRadius: "50%" },
	timelineStage: { fontSize: "0.9rem", fontWeight: 600, textTransform: "capitalize" as const },
	timelineDuration: { fontSize: "0.75rem", color: "#666" },
	browser: {
		display: "flex",
		border: "1px solid #222",
		borderRadius: 12,
		overflow: "hidden" as const,
		minHeight: 400,
	},
	sidebar: {
		width: 220,
		borderRight: "1px solid #222",
		backgroundColor: "#0d0d0d",
		overflowY: "auto" as const,
		flexShrink: 0,
	},
	fileButton: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		width: "100%",
		padding: "0.5rem 0.75rem",
		border: "1px solid transparent",
		background: "none",
		color: "#e0e0e0",
		cursor: "pointer",
		fontSize: "0.85rem",
		textAlign: "left" as const,
	},
	fileName: { color: "#DAA520" },
	fileLang: { color: "#555", fontSize: "0.75rem" },
	codePanel: { flex: 1, backgroundColor: "#111", overflow: "auto" as const },
	codePanelHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		padding: "0.5rem 1rem",
		borderBottom: "1px solid #222",
		backgroundColor: "#0d0d0d",
	},
	codeFilePath: { fontSize: "0.85rem", color: "#888" },
	codeLang: { fontSize: "0.75rem", color: "#555" },
	codeBlock: {
		margin: 0,
		padding: "1rem",
		fontSize: "0.85rem",
		lineHeight: 1.5,
		color: "#d4d4d4",
		overflow: "auto" as const,
		whiteSpace: "pre-wrap" as const,
		wordBreak: "break-word" as const,
	},
};
