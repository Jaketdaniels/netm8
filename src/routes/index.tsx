import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "../api";

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
		<div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center px-8 pt-24 pb-16">
			<h1 className="mb-2 bg-gradient-to-br from-primary via-chart-4 to-chart-2 bg-clip-text text-5xl font-extrabold tracking-tight text-transparent">
				NetM8
			</h1>
			<p className="mb-8 text-muted-foreground">Describe software. Watch it grow.</p>

			<Button asChild size="lg" className="mb-12">
				<Link to="/spawn">Spawn Software</Link>
			</Button>

			<nav className="mb-8 flex gap-4">
				<Button asChild variant="ghost" size="sm">
					<Link to="/spawn">Spawn</Link>
				</Button>
				<Button asChild variant="ghost" size="sm">
					<Link to="/spawns">Projects</Link>
				</Button>
			</nav>

			{health.isLoading ? (
				<p className="text-sm text-muted-foreground">Connecting...</p>
			) : health.error ? (
				<p className="text-sm text-destructive-foreground">Error: {health.error.message}</p>
			) : (
				<Badge variant="secondary">
					{(health.data as Record<string, string>).name} v
					{(health.data as Record<string, string>).version} (
					{(health.data as Record<string, string>).env})
				</Badge>
			)}
		</div>
	);
}
