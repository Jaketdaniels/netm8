import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
		<div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
			<h1>NetM8</h1>
			{health.isLoading ? (
				<p>Loading...</p>
			) : health.error ? (
				<p>Error: {health.error.message}</p>
			) : (
				<pre>{JSON.stringify(health.data, null, 2)}</pre>
			)}
		</div>
	);
}
