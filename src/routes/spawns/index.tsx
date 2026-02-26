import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "../../client/api";

export const Route = createFileRoute("/spawns/")({
	component: SpawnsList,
});

function SpawnsList() {
	const { data, isLoading, error } = useQuery({
		queryKey: ["spawns"],
		queryFn: async () => {
			const res = await api.api.spawns.$get();
			if (!res.ok) throw new Error("Failed to fetch spawns");
			return res.json();
		},
	});

	return (
		<div style={styles.container}>
			<header style={styles.header}>
				<a href="/" style={styles.backLink}>
					netm8
				</a>
				<h1 style={styles.title}>Spawned Projects</h1>
				<Link to="/spawn" style={styles.newButton}>
					+ New Spawn
				</Link>
			</header>

			{isLoading && <p style={styles.muted}>Loading...</p>}
			{error && <p style={styles.error}>Error: {error.message}</p>}

			{data && (data as Array<Record<string, unknown>>).length === 0 && (
				<div style={styles.empty}>
					<p>No projects spawned yet.</p>
					<Link to="/spawn" style={styles.spawnLink}>
						Create your first spawn
					</Link>
				</div>
			)}

			<div style={styles.grid}>
				{data &&
					(data as Array<Record<string, string | null>>).map((spawn) => (
						<a key={spawn.id} href={`/spawns/${spawn.id}`} style={styles.card}>
							<div style={styles.cardHeader}>
								<span style={styles.name}>{spawn.name ?? "Unnamed"}</span>
								<span
									style={{
										...styles.status,
										color:
											spawn.status === "complete"
												? "#4CAF50"
												: spawn.status === "failed"
													? "#ff6b6b"
													: "#DAA520",
									}}
								>
									{spawn.status}
								</span>
							</div>
							<p style={styles.description}>{spawn.description ?? spawn.prompt}</p>
							<div style={styles.meta}>
								{spawn.platform && <span style={styles.tag}>{spawn.platform}</span>}
								<span style={styles.stage}>{spawn.stage}</span>
							</div>
						</a>
					))}
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		maxWidth: 900,
		margin: "0 auto",
		padding: "2rem",
		fontFamily: "system-ui, -apple-system, sans-serif",
		color: "#e0e0e0",
		backgroundColor: "#0a0a0a",
		minHeight: "100vh",
	},
	header: {
		display: "flex",
		alignItems: "baseline",
		gap: "1rem",
		marginBottom: "2rem",
		flexWrap: "wrap" as const,
	},
	backLink: { color: "#666", textDecoration: "none", fontSize: "0.85rem" },
	title: { fontSize: "1.5rem", fontWeight: 700, margin: 0, flex: 1 },
	newButton: {
		padding: "0.5rem 1rem",
		backgroundColor: "#228B22",
		color: "#fff",
		borderRadius: 8,
		textDecoration: "none",
		fontSize: "0.9rem",
		fontWeight: 600,
	},
	muted: { color: "#666" },
	error: { color: "#ff6b6b" },
	empty: { textAlign: "center" as const, padding: "3rem 0", color: "#666" },
	spawnLink: { color: "#228B22", textDecoration: "none", fontWeight: 600 },
	grid: { display: "flex", flexDirection: "column" as const, gap: "0.75rem" },
	card: {
		display: "block",
		backgroundColor: "#111",
		border: "1px solid #222",
		borderRadius: 12,
		padding: "1.25rem",
		textDecoration: "none",
		color: "inherit",
		transition: "border-color 0.2s",
	},
	cardHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: "0.5rem",
	},
	name: { fontSize: "1.1rem", fontWeight: 600, color: "#e0e0e0" },
	status: { fontSize: "0.8rem", fontWeight: 600, textTransform: "uppercase" as const },
	description: { color: "#888", margin: "0 0 0.75rem", fontSize: "0.9rem" },
	meta: { display: "flex", gap: "0.5rem", alignItems: "center" },
	tag: {
		padding: "0.15rem 0.5rem",
		backgroundColor: "#1a1a2e",
		border: "1px solid #333",
		borderRadius: 10,
		fontSize: "0.75rem",
		color: "#8B8",
	},
	stage: { fontSize: "0.75rem", color: "#666" },
};
