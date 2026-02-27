import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { DnaIcon, FolderIcon, HomeIcon, UserIcon } from "lucide-react";
import { useCallback } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { api } from "../../api";

interface Spawn {
	id: string;
	name: string | null;
	description: string | null;
	prompt: string;
	status: string;
}

interface CommandPaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
	const navigate = useNavigate();

	const spawns = useQuery({
		queryKey: ["spawns"],
		queryFn: async () => {
			const res = await api.api.spawns.$get();
			if (!res.ok) throw new Error("Failed to fetch");
			return res.json() as Promise<Spawn[]>;
		},
		enabled: open,
	});

	const go = useCallback(
		(to: string, params?: Record<string, string>) => {
			onOpenChange(false);
			navigate({ to, params } as any);
		},
		[navigate, onOpenChange],
	);

	return (
		<CommandDialog open={open} onOpenChange={onOpenChange}>
			<CommandInput placeholder="Type a command or search..." />
			<CommandList>
				<CommandEmpty>No results found.</CommandEmpty>
				<CommandGroup heading="Navigation">
					<CommandItem onSelect={() => go("/")}>
						<HomeIcon className="mr-2 size-4" />
						Home
					</CommandItem>
					<CommandItem onSelect={() => go("/spawn")}>
						<DnaIcon className="mr-2 size-4" />
						New Spawn
					</CommandItem>
					<CommandItem onSelect={() => go("/profile")}>
						<UserIcon className="mr-2 size-4" />
						Profile
					</CommandItem>
				</CommandGroup>
				<CommandSeparator />
				<CommandGroup heading="Recent Projects">
					{spawns.isLoading && (
						<div className="px-2 py-3">
							<Shimmer className="text-xs">Loading projects...</Shimmer>
						</div>
					)}
					{spawns.data && spawns.data.length === 0 && (
						<div className="px-2 py-3 text-xs text-muted-foreground">No projects yet</div>
					)}
					{spawns.data?.map((spawn) => (
						<CommandItem key={spawn.id} onSelect={() => go("/spawn/$id", { id: spawn.id })}>
							<FolderIcon className="mr-2 size-4" />
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="truncate">{spawn.name ?? "Unnamed"}</span>
								<span className="truncate text-xs text-muted-foreground">
									{spawn.description ?? spawn.prompt}
								</span>
							</div>
						</CommandItem>
					))}
				</CommandGroup>
			</CommandList>
		</CommandDialog>
	);
}
