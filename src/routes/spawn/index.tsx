import { useAgentChat } from "@cloudflare/ai-chat/react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { DnaIcon, DownloadIcon, PaperclipIcon, RefreshCwIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
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
import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
	Terminal,
	TerminalActions,
	TerminalContent,
	TerminalCopyButton,
	TerminalHeader,
	TerminalTitle,
} from "@/components/ai-elements/terminal";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
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
import { cn } from "@/lib/utils";
import type { SpawnAgentState } from "../../../worker/agents/spawn-agent";

// ── Route ───────────────────────────────────────────────────────────────

const spawnSearchSchema = z.object({
	q: z.string().optional(),
});

export const Route = createFileRoute("/spawn/")({
	component: SpawnPage,
	validateSearch: spawnSearchSchema,
});

// ── Helpers ─────────────────────────────────────────────────────────────

function getTextContent(message: UIMessage): string {
	const textPart = message.parts.find((p) => p.type === "text");
	return textPart && "text" in textPart ? textPart.text : "";
}

const TOOL_LABELS: Record<string, string> = {
	write_file: "Write File",
	read_file: "Read File",
	exec: "Execute Command",
	done: "Build Complete",
};

function formatExecOutput(output: unknown): string {
	if (!output) return "";
	if (typeof output === "string") {
		try {
			const parsed = JSON.parse(output) as { stdout?: string; stderr?: string };
			return [parsed.stdout, parsed.stderr].filter(Boolean).join("\n");
		} catch {
			return output;
		}
	}
	const obj = output as { stdout?: string; stderr?: string };
	return [obj.stdout, obj.stderr].filter(Boolean).join("\n");
}

function getExecExitCode(output: unknown): number | null {
	if (!output) return null;
	try {
		const obj = typeof output === "string" ? JSON.parse(output) : output;
		return (obj as { exitCode?: number }).exitCode ?? null;
	} catch {
		return null;
	}
}

// ── Tool Part Renderer ──────────────────────────────────────────────────

function ToolPart({ part }: { part: DynamicToolUIPart }) {
	const title = TOOL_LABELS[part.toolName] ?? part.toolName;
	const isRunning = part.state === "input-available" || part.state === "input-streaming";

	if (part.toolName === "write_file") {
		const path = (part.input as { path?: string })?.path ?? "";
		return (
			<Tool defaultOpen={isRunning}>
				<ToolHeader type="dynamic-tool" state={part.state} toolName={part.toolName} title={title} />
				<ToolContent>
					<div className="font-mono text-xs text-muted-foreground">{path}</div>
				</ToolContent>
			</Tool>
		);
	}

	if (part.toolName === "exec") {
		const command = (part.input as { command?: string })?.command ?? "";
		const exitCode = part.state === "output-available" ? getExecExitCode(part.output) : null;
		const output = part.state === "output-available" ? formatExecOutput(part.output) : "";

		return (
			<Tool defaultOpen={isRunning}>
				<div className="flex items-center">
					<div className="flex-1">
						<ToolHeader
							type="dynamic-tool"
							state={part.state}
							toolName={part.toolName}
							title={title}
						/>
					</div>
					{exitCode !== null && (
						<Badge
							variant="secondary"
							className={cn(
								"mr-3 font-mono text-[10px]",
								exitCode === 0 ? "text-chart-2" : "text-chart-5",
							)}
						>
							exit {exitCode}
						</Badge>
					)}
				</div>
				{output && (
					<ToolContent>
						<Terminal output={output} isStreaming={isRunning}>
							<TerminalHeader>
								<TerminalTitle>$ {command}</TerminalTitle>
								<TerminalActions>
									<TerminalCopyButton />
								</TerminalActions>
							</TerminalHeader>
							<TerminalContent />
						</Terminal>
					</ToolContent>
				)}
			</Tool>
		);
	}

	if (part.toolName === "done" && part.state === "output-available") {
		return (
			<Tool defaultOpen={false}>
				<ToolHeader type="dynamic-tool" state={part.state} toolName={part.toolName} title={title} />
				<ToolContent>
					<Reasoning defaultOpen={false}>
						<ReasoningTrigger />
						<ReasoningContent>{String(part.output ?? "")}</ReasoningContent>
					</Reasoning>
				</ToolContent>
			</Tool>
		);
	}

	// Default: generic tool display
	return (
		<Tool defaultOpen={isRunning}>
			<ToolHeader type="dynamic-tool" state={part.state} toolName={part.toolName} title={title} />
		</Tool>
	);
}

// ── Component ───────────────────────────────────────────────────────────

function SpawnPage() {
	const { q } = Route.useSearch();
	const navigate = useNavigate();
	const [prompt, setPrompt] = useState(q ?? "");
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [state, setState] = useState<SpawnAgentState | null>(null);
	const [retryPending, setRetryPending] = useState(false);
	const [attachments, setAttachments] = useState<AttachmentData[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const autoSubmittedRef = useRef(false);

	// Agent connection: state channel (spec, files, spawnId)
	const [agentName] = useState(() => crypto.randomUUID());
	const agent = useAgent<SpawnAgentState>({
		agent: "SpawnAgent",
		name: agentName,
		onStateUpdate: setState,
	});

	// Chat channel: messages, status, tool parts
	// getInitialMessages: null avoids React.use() inside useAgentChat which
	// triggers Suspense — each session uses a fresh UUID so there are no
	// persisted messages to resume via HTTP fetch.
	const { messages, sendMessage, status, clearHistory } = useAgentChat({
		agent,
		getInitialMessages: null,
	});

	const isStreaming = status === "streaming" || status === "submitted";
	const isComplete = state?.status === "complete";

	// ── Actions ─────────────────────────────────────────────────────────

	const handleSubmit = useCallback(
		({ text }: { text: string }) => {
			if (!text.trim() || isStreaming) return;
			sendMessage({ text });
			setPrompt("");
			setSelectedFile(null);
		},
		[isStreaming, sendMessage],
	);

	const handleRetry = useCallback(() => {
		if (isStreaming) return;
		const originalPrompt = getTextContent(messages[0]);
		if (!originalPrompt) return;

		agent.send(JSON.stringify({ type: "reset" }));
		clearHistory();
		setRetryPending(false);

		// Let reset propagate, then re-submit
		setTimeout(() => sendMessage({ text: originalPrompt }), 150);
	}, [isStreaming, messages, agent, clearHistory, sendMessage]);

	const handleSuggestion = useCallback((suggestion: string) => {
		setPrompt(suggestion);
	}, []);

	// Auto-submit from ?q= query param
	useEffect(() => {
		if (q && !autoSubmittedRef.current && status === "ready" && messages.length === 0) {
			autoSubmittedRef.current = true;
			sendMessage({ text: q });
			setPrompt("");
			navigate({ to: "/spawn", search: {}, replace: true });
		}
	}, [q, status, messages.length, sendMessage, navigate]);

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

	// ── File browser state ──────────────────────────────────────────────

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

	// ── Derived state ───────────────────────────────────────────────────

	const hasSpec = !!state?.spec;
	const hasMessages = messages.length > 0;
	const showEmpty = !hasMessages && !isStreaming && !hasSpec;

	// Track if the first assistant message has been rendered (for spec injection)
	const firstAssistantIndex = messages.findIndex((m) => m.role === "assistant");

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6">
			{/* Error */}
			{state?.error && (
				<div className="flex items-start justify-between rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive-foreground">
					<span>
						<strong>Error:</strong> {state.error}
					</span>
					<Button
						variant="ghost"
						size="sm"
						className="shrink-0 text-destructive-foreground"
						onClick={handleRetry}
					>
						<RefreshCwIcon className="mr-1 size-3" />
						Retry
					</Button>
				</div>
			)}

			{/* Conversation */}
			<Conversation className="min-h-[300px] rounded-lg border">
				<ConversationContent>
					{showEmpty && (
						<ConversationEmptyState
							title="What do you want to build?"
							description="Describe your software idea and we'll build it iteratively."
							icon={<DnaIcon className="size-8" />}
						/>
					)}

					{messages.map((message, index) => (
						<Fragment key={message.id}>
							{/* Inject spec plan before first assistant message */}
							{index === firstAssistantIndex && state?.spec && (
								<>
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
									<Checkpoint>
										<CheckpointIcon />
										<CheckpointTrigger>Spec Extracted</CheckpointTrigger>
									</Checkpoint>
								</>
							)}

							{/* User messages */}
							{message.role === "user" && (
								<Message from="user">
									<MessageContent>{getTextContent(message)}</MessageContent>
								</Message>
							)}

							{/* Assistant messages: tool parts + text */}
							{message.role === "assistant" && (
								<Message from="assistant">
									<MessageContent>
										{message.parts.map((part) => {
											if (part.type === "text" && part.text.trim()) {
												return (
													<MessageResponse key={`${message.id}-text`}>{part.text}</MessageResponse>
												);
											}
											if (part.type === "dynamic-tool") {
												return <ToolPart key={part.toolCallId} part={part} />;
											}
											return null;
										})}
									</MessageContent>
								</Message>
							)}
						</Fragment>
					))}

					{/* Show spec even when no assistant message yet (during extraction) */}
					{state?.spec && firstAssistantIndex === -1 && (
						<>
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
							{state.status !== "extracting-spec" && (
								<Checkpoint>
									<CheckpointIcon />
									<CheckpointTrigger>Spec Extracted</CheckpointTrigger>
								</Checkpoint>
							)}
						</>
					)}

					{/* Queue: features (inside conversation flow) */}
					{state?.spec && (isStreaming || isComplete || state.status === "failed") && (
						<Queue>
							<QueueSection defaultOpen={isStreaming}>
								<QueueSectionTrigger>
									<QueueSectionLabel count={state.spec.features.length} label="features" />
								</QueueSectionTrigger>
								<QueueSectionContent>
									<QueueList>
										{state.spec.features.map((f) => (
											<QueueItem key={f}>
												<QueueItemIndicator completed={!!isComplete} />
												<QueueItemContent completed={!!isComplete}>{f}</QueueItemContent>
											</QueueItem>
										))}
									</QueueList>
								</QueueSectionContent>
							</QueueSection>
						</Queue>
					)}

					{/* Commit summary when complete */}
					{isComplete && (
						<Message from="assistant">
							<MessageContent>
								<div className="space-y-3">
									{filePaths.length > 0 ? (
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
									) : (
										<p className="text-sm text-muted-foreground">
											Build completed but no files were generated. Try again with a more specific
											description.
										</p>
									)}
									<div className="flex items-center gap-3">
										{state.spawnId && filePaths.length > 0 && (
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
				</ConversationContent>
			</Conversation>

			{/* Suggestions (idle, no messages) */}
			{showEmpty && (
				<Suggestions className="pb-2">
					<Suggestion
						suggestion="A task management API with user auth"
						onClick={handleSuggestion}
					/>
					<Suggestion suggestion="A real-time chat app with rooms" onClick={handleSuggestion} />
					<Suggestion suggestion="A CLI tool for managing dotfiles" onClick={handleSuggestion} />
				</Suggestions>
			)}

			{/* Prompt input — single instance, not sticky */}
			<PromptInput onSubmit={handleSubmit}>
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
					placeholder={
						isComplete
							? "Give feedback to improve the project..."
							: "Describe the software you want to create..."
					}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					disabled={isStreaming}
				/>
				<PromptInputFooter>
					<div className="flex items-center gap-2">
						<input ref={fileInputRef} type="file" className="hidden" onChange={handleFileAttach} />
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
						<PromptInputSubmit disabled={isStreaming || !prompt.trim()} />
					</div>
				</PromptInputFooter>
			</PromptInput>

			{/* Sandbox — Files view */}
			{filePaths.length > 0 && folderTree && (
				<Sandbox>
					<SandboxHeader
						title="Build Sandbox"
						state={isStreaming ? "input-available" : "output-available"}
					/>
					<SandboxContent>
						<SandboxTabs defaultValue="files">
							<SandboxTabsBar>
								<SandboxTabsList>
									<SandboxTabsTrigger value="files">Files ({filePaths.length})</SandboxTabsTrigger>
								</SandboxTabsList>
							</SandboxTabsBar>

							<SandboxTabContent value="files">
								<Artifact>
									<ArtifactHeader>
										<ArtifactTitle>
											{filePaths.length} file
											{filePaths.length !== 1 ? "s" : ""} generated
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
													onSelect={(path: string) => setSelectedFile(path)}
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
