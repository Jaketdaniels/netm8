import { BookOpenIcon, CommandIcon, DnaIcon, UserIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHealth } from "@/hooks/use-health";
import { SpineItem } from "./spine-item";

interface SpineProps {
	onCommandOpen: () => void;
}

export function Spine({ onCommandOpen }: SpineProps) {
	const health = useHealth();
	const healthColor = !health.data
		? "bg-muted-foreground"
		: health.data.status === "healthy"
			? "bg-green-500"
			: "bg-yellow-500";

	return (
		<>
			{/* Desktop: vertical rail */}
			<nav className="hidden md:flex w-[52px] shrink-0 flex-col items-center gap-2 border-r bg-background py-3">
				{/* Logo */}
				<SpineItem to="/" label="Home">
					<span className="font-display text-sm font-bold tracking-tight text-foreground">n8</span>
				</SpineItem>

				<div className="my-2 h-px w-6 bg-border" />

				{/* Nav items */}
				<SpineItem to="/spawn" icon={DnaIcon} label="Spawn" />
				<SpineItem to="/profile" icon={UserIcon} label="Profile" />
				<SpineItem to="/api-docs" icon={BookOpenIcon} label="API Docs" />

				{/* Spacer */}
				<div className="flex-1" />

				{/* Health indicator */}
				<Tooltip>
					<TooltipTrigger asChild>
						<div className="flex items-center justify-center">
							<span className={`size-2 rounded-full ${healthColor}`} />
						</div>
					</TooltipTrigger>
					<TooltipContent side="right" sideOffset={8}>
						{health.data?.status ?? "checking..."}
					</TooltipContent>
				</Tooltip>

				{/* Command palette trigger */}
				<SpineItem
					label="Command Palette"
					icon={CommandIcon}
					onClick={onCommandOpen}
					shortcut="⌘K"
				/>
			</nav>

			{/* Mobile: bottom bar */}
			<nav className="flex md:hidden h-14 shrink-0 items-center justify-around border-t bg-background px-2">
				<SpineItem to="/" label="Home">
					<span className="font-display text-sm font-bold tracking-tight text-foreground">n8</span>
				</SpineItem>
				<SpineItem to="/spawn" icon={DnaIcon} label="Spawn" />
				<SpineItem to="/profile" icon={UserIcon} label="Profile" />
				<SpineItem to="/api-docs" icon={BookOpenIcon} label="API Docs" />
				<SpineItem label="⌘K" icon={CommandIcon} onClick={onCommandOpen} />
			</nav>
		</>
	);
}
