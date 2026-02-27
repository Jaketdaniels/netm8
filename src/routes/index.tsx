import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { motion } from "motion/react";
import { useCallback } from "react";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import { fadeUp, heroStagger } from "@/lib/motion";

export const Route = createFileRoute("/")({
	component: Home,
});

function Home() {
	const navigate = useNavigate();

	const handleSuggestion = useCallback(
		(suggestion: string) => {
			navigate({ to: "/spawn", search: { q: suggestion } });
		},
		[navigate],
	);

	return (
		<motion.div
			className="mx-auto flex max-w-5xl flex-1 flex-col items-center justify-center p-6"
			initial="hidden"
			animate="visible"
			variants={heroStagger}
		>
			{/* Hero */}
			<motion.div className="mb-8 flex flex-col items-center pb-6 text-center" variants={fadeUp}>
				<h1 className="mb-2 bg-gradient-to-br from-primary via-chart-4 to-chart-2 bg-clip-text font-display text-5xl font-extrabold tracking-tight text-transparent">
					NetM8
				</h1>
				<p className="mb-6 text-muted-foreground">Describe software. Watch it grow.</p>
				<Button asChild size="lg">
					<Link to="/spawn">
						<PlusIcon className="mr-1.5 size-4" />
						Spawn Software
					</Link>
				</Button>
			</motion.div>

			{/* Quick start suggestions */}
			<motion.div variants={fadeUp}>
				<h2 className="mb-3 text-center text-sm font-semibold text-muted-foreground">
					Quick Start
				</h2>
				<Suggestions>
					<Suggestion
						suggestion="A task management API with user auth"
						onClick={handleSuggestion}
					/>
					<Suggestion suggestion="A real-time chat app with rooms" onClick={handleSuggestion} />
					<Suggestion suggestion="A CLI tool for managing dotfiles" onClick={handleSuggestion} />
				</Suggestions>
			</motion.div>
		</motion.div>
	);
}
