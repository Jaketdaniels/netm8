import { createFileRoute } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import { Loader2Icon, RocketIcon, SparklesIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockCopyButton,
	CodeBlockFilename,
	CodeBlockHeader,
	CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
	PromptInput,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildFolderTree, extToLanguage } from "@/lib/code";

// ── Types ───────────────────────────────────────────────────────────────

interface SpecData {
	name: string;
	description: string;
	platform: string;
	features: string[];
}

interface IterationSummary {
	iteration: number;
	reasoning: string;
	created: string[];
	edited: string[];
	deleted: string[];
}

interface SpawnState {
	spawnId: string | null;
	prompt: string | null;
	status: "idle" | "running" | "complete" | "failed";
	spec: SpecData | null;
	iteration: number;
	iterations: IterationSummary[];
	files: Record<string, string>;
	totalFiles: number;
	error: string | null;
	summary: string | null;
}

// ── Route ───────────────────────────────────────────────────────────────

export const Route = createFileRoute("/spawn")({
	component: SpawnPage,
});

// ── Component ───────────────────────────────────────────────────────────

function SpawnPage() {
	const [prompt, setPrompt] = useState("");
	const [state, setState] = useState<SpawnState | null>(null);
	const [agentName, setAgentName] = useState(() => crypto.randomUUID());
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const hasSentRef = useRef(false);
	const pendingRef = useRef<{ type: string; prompt: string } | null>(null);

	const agent = useAgent<SpawnState>({
		agent: "SpawnAgent",
		name: agentName,
		onStateUpdate: (newState: SpawnState) => {
			setState(newState);
			if (pendingRef.current && newState.status === "idle" && !hasSentRef.current) {
				hasSentRef.current = true;
				agent.send(JSON.stringify(pendingRef.current));
				pendingRef.current = null;
			}
		},
	});

	const isRunning = state?.status === "running";
	const isComplete = state?.status === "complete";

	const handleSpawn = useCallback(
		({ text }: { text: string }) => {
			if (!text.trim() || isRunning) return;
			hasSentRef.current = false;
			pendingRef.current = { type: "spawn", prompt: text };
			setPrompt("");
			setState(null);
			setSelectedFile(null);
			setAgentName(crypto.randomUUID());
		},
		[isRunning],
	);

	const handleFeedback = useCallback(
		({ text }: { text: string }) => {
			if (!text.trim() || isRunning || !isComplete) return;
			agent.send(JSON.stringify({ type: "feedback", prompt: text }));
		},
		[isRunning, isComplete, agent],
	);

	const handleSuggestion = useCallback((suggestion: string) => {
		setPrompt(suggestion);
	}, []);

	const filePaths = state?.files ? Object.keys(state.files) : [];
	const activeFilePath = selectedFile ?? filePaths[0] ?? null;
	const activeFileContent = activeFilePath ? state?.files[activeFilePath] : null;
	const fileItems = filePaths.map((p) => ({ path: p }));
	const { tree, rootFiles } = buildFolderTree(fileItems);

	return (
		<div className="flex min-h-screen flex-col bg-background">
			{/* Header */}
			<header className="border-b px-6 py-4">
				<div className="mx-auto flex max-w-5xl items-baseline gap-3">
					<a href="/" className="text-sm text-muted-foreground hover:text-foreground">
						netm8
					</a>
					<h1 className="bg-gradient-to-r from-primary via-chart-4 to-chart-2 bg-clip-text text-2xl font-bold text-transparent">
						spawn
					</h1>
					<span className="text-sm text-muted-foreground">Describe software. Watch it build.</span>
				</div>
			</header>

			{/* Main content */}
			<main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6">
				{/* Error */}
				{state?.error && (
					<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive-foreground">
						<strong>Error:</strong> {state.error}
					</div>
				)}

				{/* Conversation area with messages */}
				<Conversation className="min-h-[300px] rounded-lg border">
					<ConversationContent>
						{!state?.spec && !isRunning ? (
							<ConversationEmptyState
								title="What do you want to build?"
								description="Describe your software idea and we'll build it iteratively."
								icon={<SparklesIcon className="size-8" />}
							/>
						) : (
							<>
								{/* User prompt */}
								{state?.prompt && (
									<Message from="user">
										<MessageContent>{state.prompt}</MessageContent>
									</Message>
								)}

								{/* Spec card */}
								{state?.spec && (
									<Message from="assistant">
										<MessageContent>
											<Card>
												<CardHeader className="pb-3">
													<CardTitle>{state.spec.name}</CardTitle>
													<p className="text-sm text-muted-foreground">{state.spec.description}</p>
												</CardHeader>
												<CardContent>
													<div className="flex flex-wrap gap-2">
														<Badge variant="default">{state.spec.platform}</Badge>
														{state.spec.features.map((f: string) => (
															<Badge key={f} variant="secondary">
																{f}
															</Badge>
														))}
													</div>
												</CardContent>
											</Card>
										</MessageContent>
									</Message>
								)}

								{/* Iterations */}
								{state?.iterations.map((iter: IterationSummary) => (
									<Message key={iter.iteration} from="assistant">
										<MessageContent>
											<Task defaultOpen={iter.iteration === state.iterations.length}>
												<TaskTrigger title={`Iteration #${iter.iteration}`} />
												<TaskContent>
													<TaskItem>
														<MessageResponse>{iter.reasoning}</MessageResponse>
													</TaskItem>
													<TaskItem>
														<div className="flex flex-wrap gap-2">
															{iter.created.length > 0 && (
																<Badge variant="secondary" className="text-chart-2">
																	+{iter.created.length} created
																</Badge>
															)}
															{iter.edited.length > 0 && (
																<Badge variant="secondary" className="text-chart-3">
																	~{iter.edited.length} edited
																</Badge>
															)}
															{iter.deleted.length > 0 && (
																<Badge variant="secondary" className="text-chart-5">
																	-{iter.deleted.length} deleted
																</Badge>
															)}
														</div>
													</TaskItem>
												</TaskContent>
											</Task>
										</MessageContent>
									</Message>
								))}

								{/* Running indicator */}
								{isRunning && (
									<Message from="assistant">
										<MessageContent>
											<div className="flex items-center gap-3 text-sm text-muted-foreground">
												<Loader2Icon className="size-4 animate-spin" />
												<span>
													Iteration {state?.iteration ?? 1}
													{(state?.iteration ?? 1) === 1
														? " — scaffolding project..."
														: " — improving..."}
												</span>
											</div>
										</MessageContent>
									</Message>
								)}

								{/* Summary */}
								{isComplete && state?.summary && (
									<Message from="assistant">
										<MessageContent>
											<MessageResponse>{state.summary}</MessageResponse>
											{state.spawnId && (
												<Button asChild variant="link" className="mt-2 h-auto p-0">
													<a href={`/spawns/${state.spawnId}`}>View project &rarr;</a>
												</Button>
											)}
										</MessageContent>
									</Message>
								)}
							</>
						)}
					</ConversationContent>
				</Conversation>

				{/* Suggestions (when empty) */}
				{!state?.spec && !isRunning && (
					<Suggestions className="pb-2">
						<Suggestion
							suggestion="A task management API with user auth"
							onClick={handleSuggestion}
						/>
						<Suggestion suggestion="A real-time chat app with rooms" onClick={handleSuggestion} />
						<Suggestion suggestion="A CLI tool for managing dotfiles" onClick={handleSuggestion} />
					</Suggestions>
				)}

				{/* Prompt input */}
				{!isComplete ? (
					<PromptInput onSubmit={handleSpawn} className="sticky bottom-6">
						<PromptInputTextarea
							placeholder="Describe the software you want to create..."
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							disabled={isRunning}
						/>
						<PromptInputFooter>
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<RocketIcon className="size-3" />
								<span>Enter to send</span>
							</div>
							<PromptInputSubmit disabled={isRunning || !prompt.trim()} />
						</PromptInputFooter>
					</PromptInput>
				) : (
					<PromptInput onSubmit={handleFeedback} className="sticky bottom-6">
						<PromptInputTextarea placeholder="Give feedback to improve the project..." />
						<PromptInputFooter>
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<SparklesIcon className="size-3" />
								<span>Iterate on your project</span>
							</div>
							<PromptInputSubmit />
						</PromptInputFooter>
					</PromptInput>
				)}

				{/* File browser */}
				{filePaths.length > 0 && (
					<div className="flex gap-4 rounded-lg border">
						{/* File tree sidebar */}
						<div className="w-60 shrink-0 border-r p-2">
							<FileTree
								selectedPath={activeFilePath ?? undefined}
								onSelect={((path: string) => setSelectedFile(path)) as any}
								defaultExpanded={new Set(Object.keys(tree))}
							>
								{Object.entries(tree).map(([folder, items]) => (
									<FileTreeFolder key={folder} path={folder} name={folder}>
										{items.map((item) => (
											<FileTreeFile
												key={item.path}
												path={item.path}
												name={item.path.split("/").pop() ?? item.path}
											/>
										))}
									</FileTreeFolder>
								))}
								{rootFiles.map((item) => (
									<FileTreeFile key={item.path} path={item.path} name={item.path} />
								))}
							</FileTree>
						</div>

						{/* Code panel */}
						<div className="min-w-0 flex-1">
							{activeFilePath && activeFileContent != null && (
								<CodeBlock
									code={activeFileContent}
									language={extToLanguage(activeFilePath)}
									className="rounded-none border-0"
								>
									<CodeBlockHeader>
										<CodeBlockTitle>
											<CodeBlockFilename>{activeFilePath}</CodeBlockFilename>
										</CodeBlockTitle>
										<CodeBlockActions>
											<CodeBlockCopyButton />
										</CodeBlockActions>
									</CodeBlockHeader>
								</CodeBlock>
							)}
						</div>
					</div>
				)}
			</main>
		</div>
	);
}
