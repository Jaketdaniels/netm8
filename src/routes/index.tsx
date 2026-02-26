import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "../client/api";

export const Route = createFileRoute("/")({
	component: Home,
});

function Home() {
	const health = useQuery({
		queryKey: ["health"],
		queryFn: async () => {
			const res = await api.api.health.$get();
			if (!res.ok) throw new Error("Failed to fetch");
			return res.json();
		},
	});

	return (
		<div style={styles.container}>
			<div style={styles.hero}>
				<h1 style={styles.title}>NetM8</h1>
				<p style={styles.subtitle}>Describe software. Watch it grow.</p>
				<Link to="/spawn" style={styles.cta}>
					Spawn Software
				</Link>
			</div>
			<nav style={styles.nav}>
				<Link to="/spawn" style={styles.navLink}>
					Spawn
				</Link>
				<Link to="/spawns" style={styles.navLink}>
					Projects
				</Link>
			</nav>
			{health.isLoading ? (
				<p style={styles.muted}>Connecting...</p>
			) : health.error ? (
				<p style={styles.error}>Error: {health.error.message}</p>
			) : (
				<p style={styles.muted}>
					{(health.data as Record<string, string>).name} v
					{(health.data as Record<string, string>).version} (
					{(health.data as Record<string, string>).env})
				</p>
			)}
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		maxWidth: 600,
		margin: "0 auto",
		padding: "4rem 2rem",
		fontFamily: "system-ui, -apple-system, sans-serif",
		color: "#e0e0e0",
		backgroundColor: "#0a0a0a",
		minHeight: "100vh",
		textAlign: "center" as const,
	},
	hero: { marginBottom: "2rem" },
	title: {
		fontSize: "3rem",
		fontWeight: 800,
		margin: "0 0 0.5rem",
		background: "linear-gradient(135deg, #6B8E23, #228B22, #DAA520)",
		WebkitBackgroundClip: "text",
		WebkitTextFillColor: "transparent",
	},
	subtitle: { color: "#888", fontSize: "1.1rem", margin: "0 0 1.5rem" },
	cta: {
		display: "inline-block",
		padding: "0.75rem 2.5rem",
		backgroundColor: "#228B22",
		color: "#fff",
		borderRadius: 8,
		textDecoration: "none",
		fontSize: "1.1rem",
		fontWeight: 600,
	},
	nav: { display: "flex", justifyContent: "center", gap: "1.5rem", marginBottom: "2rem" },
	navLink: { color: "#6BA3D6", textDecoration: "none", fontSize: "0.9rem" },
	muted: { color: "#555", fontSize: "0.85rem" },
	error: { color: "#ff6b6b", fontSize: "0.85rem" },
};
