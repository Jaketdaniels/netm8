import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "../../client/api";

export const Route = createFileRoute("/spawns/")({
	component: SpawnsList,
});

function statusColor(status: string | null) {
	if (status === "complete") return "default";
	if (status === "failed") return "destructive";
	return "secondary";
}

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
		<div className="mx-auto min-h-screen max-w-4xl p-6">
			<header className="mb-8 flex items-baseline gap-4">
				<a href="/" className="text-sm text-muted-foreground hover:text-foreground">
					netm8
				</a>
				<h1 className="flex-1 text-xl font-bold">Spawned Projects</h1>
				<Button asChild size="sm">
					<Link to="/spawn">
						<PlusIcon className="mr-1.5 size-4" />
						New Spawn
					</Link>
				</Button>
			</header>

			{isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
			{error && <p className="text-sm text-destructive-foreground">Error: {error.message}</p>}

			{data && (data as Array<Record<string, unknown>>).length === 0 && (
				<div className="py-16 text-center text-muted-foreground">
					<p className="mb-3">No projects spawned yet.</p>
					<Button asChild variant="link">
						<Link to="/spawn">Create your first spawn</Link>
					</Button>
				</div>
			)}

			<div className="flex flex-col gap-3">
				{data &&
					(data as Array<Record<string, string | null>>).map((spawn) => (
						<a key={spawn.id} href={`/spawns/${spawn.id}`} className="block no-underline">
							<Card className="transition-colors hover:border-primary/30">
								<CardHeader className="flex-row items-center justify-between pb-2">
									<CardTitle className="text-base">{spawn.name ?? "Unnamed"}</CardTitle>
									<Badge variant={statusColor(spawn.status)}>{spawn.status}</Badge>
								</CardHeader>
								<CardContent>
									<p className="mb-3 text-sm text-muted-foreground">
										{spawn.description ?? spawn.prompt}
									</p>
									{spawn.platform && (
										<div className="flex gap-2">
											<Badge variant="outline">{spawn.platform}</Badge>
										</div>
									)}
								</CardContent>
							</Card>
						</a>
					))}
			</div>
		</div>
	);
}
