import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CommandPalette } from "@/components/layout/command-palette";
import { Spine } from "@/components/layout/spine";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRoute({
	component: RootLayout,
});

function RootLayout() {
	const [commandOpen, setCommandOpen] = useState(false);

	const handleCommandOpen = useCallback(() => setCommandOpen(true), []);

	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setCommandOpen((prev) => !prev);
			}
		};
		document.addEventListener("keydown", down);
		return () => document.removeEventListener("keydown", down);
	}, []);

	return (
		<TooltipProvider>
			<div className="flex h-screen flex-col md:flex-row">
				{/* Desktop spine (left rail) */}
				<Spine onCommandOpen={handleCommandOpen} />

				{/* Main content area */}
				<main className="flex-1 overflow-auto">
					<Outlet />
				</main>

				{/* Mobile spine is rendered inside Spine component as bottom bar */}
			</div>
			<CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
			<ReactQueryDevtools buttonPosition="bottom-left" />
		</TooltipProvider>
	);
}
