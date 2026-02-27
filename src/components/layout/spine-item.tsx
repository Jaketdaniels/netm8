import { Link, useMatchRoute } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface SpineItemProps {
	to?: string;
	icon?: LucideIcon;
	label: string;
	onClick?: () => void;
	children?: ReactNode;
	shortcut?: string;
	overlay?: ReactNode;
}

export function SpineItem({
	to,
	icon: Icon,
	label,
	onClick,
	children,
	shortcut,
	overlay,
}: SpineItemProps) {
	const matchRoute = useMatchRoute();
	const isActive = to ? !!matchRoute({ to, fuzzy: true }) : false;

	const buttonClasses = cn(
		"relative flex size-10 items-center justify-center rounded-lg transition-colors",
		isActive
			? "bg-primary/15 text-primary"
			: "text-muted-foreground hover:bg-accent hover:text-foreground",
	);

	const inner = (
		<>
			{children ?? (Icon && <Icon className="size-5" />)}
			{overlay}
		</>
	);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{to ? (
					<Link to={to} className={buttonClasses}>
						{inner}
					</Link>
				) : (
					<button type="button" onClick={onClick} className={buttonClasses}>
						{inner}
					</button>
				)}
			</TooltipTrigger>
			<TooltipContent side="right" sideOffset={8}>
				<span>{label}</span>
				{shortcut && <kbd className="ml-2 font-mono text-xs text-muted-foreground">{shortcut}</kbd>}
			</TooltipContent>
		</Tooltip>
	);
}
