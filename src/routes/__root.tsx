import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRoute({
	component: () => (
		<TooltipProvider>
			<Outlet />
			<ReactQueryDevtools buttonPosition="bottom-left" />
		</TooltipProvider>
	),
});
