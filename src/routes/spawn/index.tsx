import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import {
	CheckCircleIcon,
	DnaIcon,
	DownloadIcon,
	FileIcon,
	Loader2Icon,
	PaperclipIcon,
	RefreshCwIcon,
	TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
	Artifact,
	ArtifactAction,
	ArtifactActions,
	ArtifactContent,
	ArtifactHeader,
	ArtifactTitle,
} from "@/components/ai-elements/artifact";
import type { AttachmentData } from "@/components/ai-elements/attachments";
import {
	Attachment,
	AttachmentInfo,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "@/components/ai-elements/attachments";
import {
	ChainOfThought,
	ChainOfThoughtContent,
	ChainOfThoughtHeader,
	ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint";
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockCopyButton,
	CodeBlockFilename,
	CodeBlockHeader,
	CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
	Commit,
	CommitContent,
	CommitFile,
	CommitFileIcon,
	CommitFileInfo,
	CommitFilePath,
	CommitFileStatus,
	CommitFiles,
	CommitHeader,
	CommitInfo,
	CommitMessage,
} from "@/components/ai-elements/commit";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
	OpenIn,
	OpenInClaude,
	OpenInContent,
	OpenInLabel,
	OpenInTrigger,
} from "@/components/ai-elements/open-in-chat";
import {
	Plan,
	PlanContent,
	PlanDescription,
	PlanHeader,
	PlanTitle,
	PlanTrigger,
} from "@/components/ai-elements/plan";
import {
	PromptInput,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import {
	Queue,
	QueueItem,
	QueueItemContent,
	QueueItemIndicator,
	QueueList,
	QueueSection,
	QueueSectionContent,
	QueueSectionLabel,
	QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
	Sandbox,
	SandboxContent,
	SandboxHeader,
	SandboxTabContent,
	SandboxTabs,
	SandboxTabsBar,
	SandboxTabsList,
	SandboxTabsTrigger,
} from "@/components/ai-elements/sandbox";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
	Task,
	TaskContent,
	TaskItem,
	TaskItemFile,
	TaskTrigger,
} from "@/components/ai-elements/task";
import {
	Terminal,
	TerminalActions,
	TerminalContent,
	TerminalCopyButton,
	TerminalHeader,
	TerminalTitle,
} from "@/components/ai-elements/terminal";
import {
	Test,
	TestResults,
	TestResultsContent,
	TestResultsHeader,
	TestResultsSummary as TestResultsSummaryDisplay,
	TestSuite,
	TestSuiteContent,
	TestSuiteName,
} from "@/components/ai-elements/test-results";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildFolderTree, extToLanguage } from "@/lib/code";
import type { AgentStep } from "../../shared/schemas";

// ── Types ───────────────────────────────────────────────────────────────

interface SpecData {
	name: string;
	description: string;
	platform: string;
	features: string[];
}

interface SpawnState {
	spawnId: string | null;
	prompt: string | null;
	status: "idle" | "extracting-spec" | "building" | "complete" | "failed";
	spec: SpecData | null;
	steps: AgentStep[];
	files: Record<string, string>;
	buildLog: string | null;
	error: string | null;
}

// ── Route ───────────────────────────────────────────────────────────────

const spawnSearchSchema = z.object({
	q: z.string().optional(),
});

export const Route = createFileRoute("/spawn/")({
	component: SpawnPage,
	validateSearch: spawnSearchSchema,
});

// ── Helpers ─────────────────────────────────────────────────────────────

function isFeatureDone(feature: string, steps: AgentStep[]): boolean {
	const keyword = feature.toLowerCase();
	return steps.some((s) => {
		const path = (s.toolArgs?.path as string | undefined)?.toLowerCase() ?? "";
		const summary = (s.result ?? "").toLowerCase();
		return path.includes(keyword) || summary.includes(keyword);
	});
}

interface ParsedTestResults {
	summary: { passed: number; failed: number; skipped: number; total: number };
	suites: Array<{
		name: string;
		status: "passed" | "failed";
		tests: Array<{ name: string; status: "passed" | "failed" | "skipped" }>;
	}>;
}

function parseTestOutput(buildLog: string): ParsedTestResults | null {
	// Look for TAP-like or Jest/Vitest-like output patterns
	const passMatch = buildLog.match(/(\d+)\s+(?:passing|passed)/i);
	const failMatch = buildLog.match(/(\d+)\s+(?:failing|failed)/i);
	const skipMatch = buildLog.match(/(\d+)\s+(?:pending|skipped)/i);

	const passed = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
	const failed = failMatch ? Number.parseInt(failMatch[1], 10) : 0;
	const skipped = skipMatch ? Number.parseInt(skipMatch[1], 10) : 0;
	const total = passed + failed + skipped;

	if (total === 0) return null;

	return {
		summary: { passed, failed, skipped, total },
		suites: [
			{
				name: "Test Suite",
				status: failed > 0 ? "failed" : "passed",
				tests: [],
			},
		],
	};
}

// ── Component ───────────────────────────────────────────────────────────

function SpawnPage() {
	const { q } = Route.useSearch();
	const navigate = useNavigate();
	const [prompt, setPrompt] = useState(q ?? "");
	const [state, setState] = useState<SpawnState | null>(null);
	const [agentName, setAgentName] = useState(() => crypto.randomUUID());
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [retryPending, setRetryPending] = useState(false);
	const [attachments, setAttachments] = useState<AttachmentData[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const hasSentRef = useRef(false);
	const pendingRef = useRef<{ type: string; prompt: string } | null>(null);
	const autoSubmittedRef = useRef(false);

	const agent = useAgent<SpawnState>({
		agent: "SpawnAgent",
		name: agentName,
		onStateUpdate: setState,
	});

	const isActive = state?.status === "extracting-spec" || state?.status === "building";
	const isComplete = state?.status === "complete";

	// Send pending message when new agent connects with idle state.
	// This must be in useEffect (not onStateUpdate) because onStateUpdate
	// captures a stale `agent` ref when setAgentName triggers a reconnection.
	useEffect(() => {
		if (pendingRef.current && state?.status === "idle" && !hasSentRef.current) {
			hasSentRef.current = true;
			agent.send(JSON.stringify(pendingRef.current));
			pendingRef.current = null;
		}
	}, [state?.status, agent]);

	const handleSpawn = useCallback(
		({ text }: { text: string }) => {
			if (!text.trim() || isActive) return;
			hasSentRef.current = false;
			pendingRef.current = { type: "spawn", prompt: text };
			setPrompt("");
			setState(null);
			setSelectedFile(null);
			setAgentName(crypto.randomUUID());
		},
		[isActive],
	);

	const handleFeedback = useCallback(
		({ text }: { text: string }) => {
			if (!text.trim() || isActive || !isComplete) return;
			agent.send(JSON.stringify({ type: "feedback", prompt: text }));
		},
		[isActive, isComplete, agent],
	);

	const handleRetry = useCallback(() => {
		if (isActive || !state?.prompt) return;
		agent.send(JSON.stringify({ type: "retry" }));
		setRetryPending(false);
	}, [isActive, state?.prompt, agent]);

	const handleSuggestion = useCallback((suggestion: string) => {
		setPrompt(suggestion);
	}, []);

	// Auto-submit when arriving with ?q= from home page
	useEffect(() => {
		if (q && !autoSubmittedRef.current && state?.status === "idle") {
			autoSubmittedRef.current = true;
			handleSpawn({ text: q });
			navigate({ to: "/spawn", search: {}, replace: true });
		}
	}, [q, state?.status, handleSpawn, navigate]);

	const handleFileAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const url = URL.createObjectURL(file);
		const newAttachment: AttachmentData = {
			id: crypto.randomUUID(),
			type: "file",
			url,
			filename: file.name,
			mediaType: file.type,
		};
		setAttachments((prev) => [...prev, newAttachment]);
		e.target.value = "";
	}, []);

	const removeAttachment = useCallback((id: string) => {
		setAttachments((prev) => prev.filter((a) => a.id !== id));
	}, []);

	// Categorize steps for display
	const writeSteps = useMemo(
		() => (state?.steps ?? []).filter((s) => s.toolName === "write_file"),
		[state?.steps],
	);
	const execSteps = useMemo(
		() => (state?.steps ?? []).filter((s) => s.toolName === "exec"),
		[state?.steps],
	);
	const doneStep = useMemo(
		() => (state?.steps ?? []).find((s) => s.toolName === "done"),
		[state?.steps],
	);

	// Parse test results from build log
	const testResults = useMemo(() => {
		if (!state?.buildLog) return null;
		return parseTestOutput(state.buildLog);
	}, [state?.buildLog]);

	// File browser state
	const filePaths = Object.keys(state?.files ?? {});
	const activeFilePath = selectedFile ?? filePaths[0] ?? null;
	const activeFileContent = activeFilePath ? state?.files?.[activeFilePath] : null;
	const fileItems = filePaths.map((p) => ({ path: p }));
	const folderTree = filePaths.length > 0 ? buildFolderTree(fileItems) : null;

	const handleDownload = () => {
		const content = JSON.stringify(state?.files ?? {}, null, 2);
		const blob = new Blob([content], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${state?.spec?.name ?? "spawn"}-files.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6">
			{/* Error */}
			{state?.error && (
				<div className="flex items-start justify-between rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive-foreground">
					<span>
						<strong>Error:</strong> {state.error}
					</span>
					{state.prompt && (
						<Button
							variant="ghost"
							size="sm"
							className="shrink-0 text-destructive-foreground"
							onClick={handleRetry}
						>
							<RefreshCwIcon className="mr-1 size-3" />
							Retry
						</Button>
					)}
				</div>
			)}

			{/* Conversation */}
			<Conversation className="min-h-[300px] rounded-lg border">
				<ConversationContent>
					{!state?.spec && !isActive ? (
						<ConversationEmptyState
							title="What do you want to build?"
							description="Describe your software idea and we'll build it iteratively."
							icon={<DnaIcon className="size-8" />}
						/>
					) : (
						<>
							{/* User prompt */}
							{state?.prompt && (
								<Message from="user">
									<MessageContent>{state.prompt}</MessageContent>
								</Message>
							)}

							{/* Plan */}
							{state?.spec && (
								<Message from="assistant">
									<MessageContent>
										<Plan isStreaming={state.status === "extracting-spec"} defaultOpen>
											<PlanHeader>
												<div className="flex-1">
													<PlanTitle>{state.spec.name}</PlanTitle>
													<PlanDescription>{state.spec.description}</PlanDescription>
												</div>
												<PlanTrigger />
											</PlanHeader>
											<PlanContent>
												<div className="flex flex-wrap gap-2">
													<Badge variant="default">{state.spec.platform}</Badge>
													{state.spec.features.map((f) => (
														<Badge key={f} variant="secondary">
															{f}
														</Badge>
													))}
												</div>
											</PlanContent>
										</Plan>
									</MessageContent>
								</Message>
							)}

							{/* Checkpoint: Spec Extracted */}
							{state?.spec && state.status !== "extracting-spec" && (
								<Checkpoint>
									<CheckpointIcon />
									<CheckpointTrigger>Spec Extracted</CheckpointTrigger>
								</Checkpoint>
							)}

							{/* Chain of Thought — tool call steps */}
							{(state?.steps.length ?? 0) > 0 && (
								<Message from="assistant">
									<MessageContent>
										<ChainOfThought defaultOpen>
											<ChainOfThoughtHeader>Build Progress</ChainOfThoughtHeader>
											<ChainOfThoughtContent>
												{writeSteps.length > 0 && (
													<ChainOfThoughtStep
														status={isActive ? "active" : "complete"}
														label={`${writeSteps.length} file${writeSteps.length !== 1 ? "s" : ""} written`}
														icon={FileIcon}
													>
														<Task defaultOpen>
															<TaskTrigger title={`${writeSteps.length} files written`} />
															<TaskContent>
																{writeSteps.map((s) => (
																	<TaskItem key={s.id}>
																		<TaskItemFile>{s.toolArgs?.path as string}</TaskItemFile>
																	</TaskItem>
																))}
															</TaskContent>
														</Task>
													</ChainOfThoughtStep>
												)}

												{execSteps.length > 0 && (
													<ChainOfThoughtStep
														status={isActive ? "active" : "complete"}
														label={`${execSteps.length} command${execSteps.length !== 1 ? "s" : ""} executed`}
														icon={TerminalIcon}
													>
														<Task defaultOpen>
															<TaskTrigger title={`${execSteps.length} commands executed`} />
															<TaskContent>
																{execSteps.map((s) => {
																	const parsed = s.result
																		? (() => {
																				try {
																					return JSON.parse(s.result) as {
																						exitCode: number;
																					};
																				} catch {
																					return null;
																				}
																			})()
																		: null;
																	return (
																		<TaskItem key={s.id}>
																			<div className="flex items-center gap-2 font-mono text-xs">
																				<span className="text-muted-foreground">$</span>
																				<span>{s.toolArgs?.command as string}</span>
																				{parsed && (
																					<Badge
																						variant="secondary"
																						className={
																							parsed.exitCode === 0
																								? "text-chart-2"
																								: "text-chart-5"
																						}
																					>
																						exit {parsed.exitCode}
																					</Badge>
																				)}
																			</div>
																		</TaskItem>
																	);
																})}
															</TaskContent>
														</Task>
													</ChainOfThoughtStep>
												)}

												{/* Active building indicator */}
												{isActive && (
													<ChainOfThoughtStep
														status="active"
														label={
															<span className="flex items-center gap-2">
																<Shimmer>building...</Shimmer>
															</span>
														}
														icon={Loader2Icon}
													/>
												)}

												{/* Done step */}
												{doneStep && (
													<ChainOfThoughtStep
														status="complete"
														label="Build complete"
														icon={CheckCircleIcon}
													>
														<Reasoning defaultOpen={false}>
															<ReasoningTrigger />
															<ReasoningContent>
																{doneStep.toolArgs?.summary as string}
															</ReasoningContent>
														</Reasoning>
													</ChainOfThoughtStep>
												)}
											</ChainOfThoughtContent>
										</ChainOfThought>
									</MessageContent>
								</Message>
							)}

							{/* Commit summary */}
							{isComplete && filePaths.length > 0 && (
								<Message from="assistant">
									<MessageContent>
										<div className="space-y-3">
											<Commit defaultOpen>
												<CommitHeader>
													<CommitInfo>
														<CommitMessage>
															{filePaths.length} file
															{filePaths.length !== 1 ? "s" : ""} generated
														</CommitMessage>
													</CommitInfo>
												</CommitHeader>
												<CommitContent>
													<CommitFiles>
														{filePaths.map((path) => (
															<CommitFile key={path}>
																<CommitFileInfo>
																	<CommitFileStatus status="added" />
																	<CommitFileIcon />
																	<CommitFilePath>{path}</CommitFilePath>
																</CommitFileInfo>
															</CommitFile>
														))}
													</CommitFiles>
												</CommitContent>
											</Commit>
											<div className="flex items-center gap-3">
												{state.spawnId && (
													<Button asChild variant="link" className="h-auto p-0">
														<Link to="/spawn/$id" params={{ id: state.spawnId }}>
															View project →
														</Link>
													</Button>
												)}
												<Button
													variant="ghost"
													size="sm"
													className="h-auto p-0 text-muted-foreground"
													onClick={() => setRetryPending(true)}
												>
													<RefreshCwIcon className="mr-1 size-3" />
													Retry
												</Button>
											</div>
											<AlertDialog open={retryPending} onOpenChange={setRetryPending}>
												<AlertDialogContent>
													<AlertDialogHeader>
														<AlertDialogTitle>Retry build?</AlertDialogTitle>
														<AlertDialogDescription>
															This will delete the current build and start over.
														</AlertDialogDescription>
													</AlertDialogHeader>
													<AlertDialogFooter>
														<AlertDialogCancel>Cancel</AlertDialogCancel>
														<AlertDialogAction onClick={handleRetry}>Retry</AlertDialogAction>
													</AlertDialogFooter>
												</AlertDialogContent>
											</AlertDialog>
										</div>
									</MessageContent>
								</Message>
							)}

							{/* Checkpoint: Build Complete */}
							{isComplete && (
								<Checkpoint>
									<CheckpointIcon />
									<CheckpointTrigger>Build Complete</CheckpointTrigger>
								</Checkpoint>
							)}
						</>
					)}
				</ConversationContent>
			</Conversation>

			{/* Suggestions */}
			{!state?.spec && !isActive && (
				<Suggestions className="pb-2">
					<Suggestion
						suggestion="A task management API with user auth"
						onClick={handleSuggestion}
					/>
					<Suggestion suggestion="A real-time chat app with rooms" onClick={handleSuggestion} />
					<Suggestion suggestion="A CLI tool for managing dotfiles" onClick={handleSuggestion} />
				</Suggestions>
			)}

			{/* Queue — feature progress during build */}
			{isActive && state?.spec && (
				<Queue>
					<QueueSection>
						<QueueSectionTrigger>
							<QueueSectionLabel count={state.spec.features.length} label="features" />
						</QueueSectionTrigger>
						<QueueSectionContent>
							<QueueList>
								{state.spec.features.map((f) => (
									<QueueItem key={f}>
										<div className="flex items-center gap-2">
											<QueueItemIndicator completed={isFeatureDone(f, writeSteps)} />
											<QueueItemContent completed={isFeatureDone(f, writeSteps)}>
												{f}
											</QueueItemContent>
										</div>
									</QueueItem>
								))}
							</QueueList>
						</QueueSectionContent>
					</QueueSection>
				</Queue>
			)}

			{/* Prompt input */}
			{!isComplete ? (
				<PromptInput onSubmit={handleSpawn} className="sticky bottom-6">
					{attachments.length > 0 && (
						<Attachments variant="inline" className="px-3 pt-2">
							{attachments.map((a) => (
								<Attachment key={a.id} data={a} onRemove={() => removeAttachment(a.id)}>
									<AttachmentPreview />
									<AttachmentInfo />
									<AttachmentRemove />
								</Attachment>
							))}
						</Attachments>
					)}
					<PromptInputTextarea
						placeholder="Describe the software you want to create..."
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						disabled={isActive}
					/>
					<PromptInputFooter>
						<div className="flex items-center gap-2">
							<input
								ref={fileInputRef}
								type="file"
								className="hidden"
								onChange={handleFileAttach}
							/>
							<Button
								variant="ghost"
								size="sm"
								className="h-auto gap-1 px-1.5 py-0.5 text-xs text-muted-foreground"
								onClick={() => fileInputRef.current?.click()}
								type="button"
							>
								<PaperclipIcon className="size-3" />
							</Button>
							<Badge variant="outline" className="text-xs font-normal">
								<DnaIcon className="mr-1 size-3" />
								Llama 3.3 70B
							</Badge>
						</div>
						<div className="flex items-center gap-2">
							<SpeechInput
								size="sm"
								className="size-8"
								onTranscriptionChange={(text) => setPrompt((prev) => `${prev} ${text}`.trim())}
							/>
							<PromptInputSubmit disabled={isActive || !prompt.trim()} />
						</div>
					</PromptInputFooter>
				</PromptInput>
			) : (
				<PromptInput onSubmit={handleFeedback} className="sticky bottom-6">
					<PromptInputTextarea placeholder="Give feedback to improve the project..." />
					<PromptInputFooter>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<DnaIcon className="size-3" />
							<span>Iterate on your project</span>
						</div>
						<PromptInputSubmit />
					</PromptInputFooter>
				</PromptInput>
			)}

			{/* Sandbox — tabbed Terminal + Files view */}
			{(state?.buildLog || (filePaths.length > 0 && folderTree)) && (
				<Sandbox>
					<SandboxHeader
						title="Build Sandbox"
						state={isActive ? "input-available" : "output-available"}
					/>
					<SandboxContent>
						<SandboxTabs defaultValue={state?.buildLog ? "terminal" : "files"}>
							<SandboxTabsBar>
								<SandboxTabsList>
									{state?.buildLog && (
										<SandboxTabsTrigger value="terminal">Terminal</SandboxTabsTrigger>
									)}
									{filePaths.length > 0 && (
										<SandboxTabsTrigger value="files">
											Files ({filePaths.length})
										</SandboxTabsTrigger>
									)}
								</SandboxTabsList>
							</SandboxTabsBar>

							{state?.buildLog && (
								<SandboxTabContent value="terminal">
									<Terminal output={state.buildLog} isStreaming={isActive}>
										<TerminalHeader>
											<TerminalTitle>Build Output</TerminalTitle>
											<TerminalActions>
												<TerminalCopyButton />
											</TerminalActions>
										</TerminalHeader>
										<TerminalContent />
									</Terminal>

									{/* Test Results — parsed from build log */}
									{testResults && (
										<TestResults summary={testResults.summary}>
											<TestResultsHeader>
												<TestResultsSummaryDisplay />
											</TestResultsHeader>
											{testResults.suites.length > 0 && (
												<TestResultsContent>
													{testResults.suites.map((suite) => (
														<TestSuite key={suite.name} name={suite.name} status={suite.status}>
															<TestSuiteName />
															{suite.tests.length > 0 && (
																<TestSuiteContent>
																	{suite.tests.map((t) => (
																		<Test key={t.name} name={t.name} status={t.status} />
																	))}
																</TestSuiteContent>
															)}
														</TestSuite>
													))}
												</TestResultsContent>
											)}
										</TestResults>
									)}
								</SandboxTabContent>
							)}

							{filePaths.length > 0 && folderTree && (
								<SandboxTabContent value="files">
									<Artifact>
										<ArtifactHeader>
											<ArtifactTitle>
												{filePaths.length} file{filePaths.length !== 1 ? "s" : ""} generated
											</ArtifactTitle>
											<ArtifactActions>
												<OpenIn query={`Review code for ${state?.spec?.name ?? "this project"}`}>
													<OpenInTrigger />
													<OpenInContent>
														<OpenInLabel>Open in</OpenInLabel>
														<OpenInClaude />
													</OpenInContent>
												</OpenIn>
												<ArtifactAction
													tooltip="Download files"
													icon={DownloadIcon}
													onClick={handleDownload}
												/>
											</ArtifactActions>
										</ArtifactHeader>
										<ArtifactContent className="p-0">
											<div className="flex">
												<div className="w-60 shrink-0 border-r p-2">
													<FileTree
														selectedPath={activeFilePath ?? undefined}
														onSelect={setSelectedFile as any}
														defaultExpanded={new Set(Object.keys(folderTree.tree))}
													>
														{Object.entries(folderTree.tree).map(([folder, items]) => (
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
														{folderTree.rootFiles.map((item) => (
															<FileTreeFile key={item.path} path={item.path} name={item.path} />
														))}
													</FileTree>
												</div>
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
										</ArtifactContent>
									</Artifact>
								</SandboxTabContent>
							)}
						</SandboxTabs>
					</SandboxContent>
				</Sandbox>
			)}

			{/* Run commands */}
			{state?.files?.["package.json"] && (
				<Snippet code="npm install && npm start">
					<SnippetInput />
					<SnippetCopyButton />
				</Snippet>
			)}
		</div>
	);
}
