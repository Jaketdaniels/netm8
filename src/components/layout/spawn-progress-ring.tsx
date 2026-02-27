import { cn } from "@/lib/utils";

interface SpawnProgressRingProps {
	progress: number; // 0-100
	className?: string;
}

export function SpawnProgressRing({ progress, className }: SpawnProgressRingProps) {
	const radius = 16;
	const circumference = 2 * Math.PI * radius;
	const offset = circumference - (progress / 100) * circumference;

	return (
		<svg
			role="img"
			aria-label={`Spawn progress: ${Math.round(progress)}%`}
			className={cn("pointer-events-none absolute inset-0 size-10", className)}
			viewBox="0 0 40 40"
		>
			<circle
				cx="20"
				cy="20"
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				className="text-primary/30"
			/>
			<circle
				cx="20"
				cy="20"
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeDasharray={circumference}
				strokeDashoffset={offset}
				strokeLinecap="round"
				className="text-primary transition-all duration-300"
				transform="rotate(-90 20 20)"
			/>
		</svg>
	);
}
