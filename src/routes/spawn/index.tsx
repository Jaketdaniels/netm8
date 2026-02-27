import { useAgentChat } from "@cloudflare/ai-chat/react";
import Editor from "@monaco-editor/react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import {
	ChevronUpIcon,
	CodeIcon,
	DnaIcon,
	DownloadIcon,
	EyeIcon,
	ListTodoIcon,
	PaperclipIcon,
	RefreshCwIcon,
	ScrollTextIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
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
	QueueItem,
	QueueItemContent,
	QueueItemIndicator,
	QueueList,
} from "@/components/ai-elements/queue";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { buildFolderTree } from "@/lib/code";
import { getRotatingQuickStartSuggestions } from "@/lib/quick-start-suggestions";
import { cn } from "@/lib/utils";
import type { TaskItem } from "../../../src/shared/schemas";
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

/** Map file extensions to Monaco language IDs */
function extToMonacoLanguage(path: string): string {
	const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		json: "json",
		css: "css",
		html: "html",
		md: "markdown",
		yaml: "yaml",
		yml: "yaml",
		py: "python",
		rs: "rust",
		go: "go",
		sh: "shell",
		sql: "sql",
		toml: "toml",
	};
	return map[ext] ?? "plaintext";
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

	return (
		<Tool defaultOpen={isRunning}>
			<ToolHeader type="dynamic-tool" state={part.state} toolName={part.toolName} title={title} />
		</Tool>
	);
}

// ── Task Panel (collapsible, above prompt input — VS Code terminal style) ──

function TaskPanel({ tasks }: { tasks: TaskItem[] }) {
	const completedCount = tasks.filter((t) => t.status === "complete").length;
	const [isOpen, setIsOpen] = useState(true);

	return (
		<div className="shrink-0 border-t">
			<button
				type="button"
				onClick={() => setIsOpen(!isOpen)}
				className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted/50"
			>
				<div className="flex items-center gap-2">
					<ListTodoIcon className="size-4 text-muted-foreground" />
					<span className="font-medium">Tasks</span>
					<Badge variant="secondary" className="text-xs">
						{completedCount}/{tasks.length}
					</Badge>
				</div>
				<ChevronUpIcon
					className={cn(
						"size-4 text-muted-foreground transition-transform",
						!isOpen && "rotate-180",
					)}
				/>
			</button>
			{isOpen && (
				<div className="max-h-48 overflow-y-auto px-3 pb-3">
					<QueueList>
						{tasks.map((task) => (
							<QueueItem key={task.id}>
								<QueueItemIndicator completed={task.status === "complete"} />
								<QueueItemContent completed={task.status === "complete"}>
									{task.label}
								</QueueItemContent>
							</QueueItem>
						))}
					</QueueList>
				</div>
			)}
		</div>
	);
}

// ── Workspace Panel ─────────────────────────────────────────────────────

function WorkspacePanel({
	state,
	selectedFile,
	onSelectFile,
	onApprove,
	onReject,
	onDownload,
}: {
	state: SpawnAgentState;
	selectedFile: string | null;
	onSelectFile: (path: string) => void;
	onApprove: () => void;
	onReject: () => void;
	onDownload: () => void;
}) {
	const filePaths = Object.keys(state.files);
	const activeFilePath = selectedFile ?? (state.activeFile || filePaths[0]) ?? null;
	const activeFileContent = activeFilePath ? state.files[activeFilePath] : null;
	const fileItems = filePaths.map((p) => ({ path: p }));
	const folderTree = filePaths.length > 0 ? buildFolderTree(fileItems) : null;

	const phase = state.status;
	const ws = state.workspaceStatus;

	// During awaiting-approval, show the Plan card in the workspace
	if (phase === "awaiting-approval" && state.spec) {
		return (
			<div className="flex h-full flex-col">
				<div className="flex-1 overflow-y-auto p-6">
					<Plan defaultOpen>
						<PlanHeader>
							<div className="min-w-0 flex-1">
								<PlanTitle className="uppercase tracking-wide">
									{`${state.spec.name} Specification`}
								</PlanTitle>
								<PlanDescription>{state.spec.description}</PlanDescription>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<Badge variant="default">{state.spec.platform}</Badge>
								<PlanTrigger />
							</div>
						</PlanHeader>
						<PlanContent>
							<div className="space-y-3 text-sm">
								<div>
									<span className="font-medium text-foreground">Platform</span>
									<p className="text-muted-foreground">{state.spec.platform}</p>
								</div>
								<div>
									<span className="font-medium text-foreground">
										Features ({state.spec.features.length})
									</span>
									<ul className="mt-1 list-disc pl-4 text-muted-foreground space-y-1">
										{state.spec.features.map((f) => (
											<li key={f}>{f}</li>
										))}
									</ul>
								</div>
							</div>
						</PlanContent>
					</Plan>
				</div>
				<div className="flex shrink-0 items-center justify-center gap-3 border-t p-4">
					<Button variant="outline" onClick={onReject}>
						Reject
					</Button>
					<Button onClick={onApprove}>Approve</Button>
				</div>
			</div>
		);
	}

	// Building / complete / failed — tabbed workspace with code + preview + logs
	if (phase === "building" || phase === "complete" || phase === "failed") {
		const defaultTab = ws === "preview" && state.previewUrl ? "preview" : "code";

		return (
			<Tabs defaultValue={defaultTab} value={undefined} className="flex h-full flex-col gap-0">
				<div className="flex shrink-0 items-center justify-between border-b px-2">
					<TabsList variant="line" className="h-10">
						<TabsTrigger value="code" className="gap-1.5">
							<CodeIcon className="size-3.5" />
							Files{filePaths.length > 0 ? ` (${filePaths.length})` : ""}
						</TabsTrigger>
						{state.previewUrl && (
							<TabsTrigger value="preview" className="gap-1.5">
								<EyeIcon className="size-3.5" />
								Preview
							</TabsTrigger>
						)}
						{phase === "failed" && state.error && (
							<TabsTrigger value="logs" className="gap-1.5">
								<ScrollTextIcon className="size-3.5" />
								Logs
							</TabsTrigger>
						)}
					</TabsList>
					{filePaths.length > 0 && (
						<Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={onDownload}>
							<DownloadIcon className="size-3" />
							Download
						</Button>
					)}
				</div>

				{/* Code tab: file tree + Monaco editor */}
				<TabsContent value="code" className="flex min-h-0 flex-1">
					{filePaths.length > 0 && folderTree ? (
						<div className="flex h-full w-full">
							<div className="w-52 shrink-0 overflow-y-auto border-r p-2">
								<FileTree
									selectedPath={activeFilePath ?? undefined}
									onSelect={onSelectFile}
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
									<Editor
										height="100%"
										path={activeFilePath}
										language={extToMonacoLanguage(activeFilePath)}
										value={activeFileContent}
										theme="vs-dark"
										options={{
											readOnly: true,
											minimap: { enabled: false },
											scrollBeyondLastLine: false,
											fontSize: 13,
											lineNumbers: "on",
											renderLineHighlight: "none",
											overviewRulerLanes: 0,
											hideCursorInOverviewRuler: true,
											scrollbar: { verticalScrollbarSize: 8 },
										}}
									/>
								)}
								{!activeFilePath && (
									<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
										{phase === "building"
											? "Files will appear here as they're written..."
											: "Select a file to view"}
									</div>
								)}
							</div>
						</div>
					) : (
						<div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
							{phase === "building" ? (
								<Shimmer duration={1}>Writing files...</Shimmer>
							) : (
								"No files generated"
							)}
						</div>
					)}
				</TabsContent>

				{/* Preview tab: live iframe */}
				{state.previewUrl && (
					<TabsContent value="preview" className="min-h-0 flex-1">
						<iframe
							src={state.previewUrl}
							className="size-full border-0"
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
							title="Live Preview"
						/>
					</TabsContent>
				)}

				{/* Logs tab: error output */}
				{phase === "failed" && state.error && (
					<TabsContent value="logs" className="min-h-0 flex-1 overflow-y-auto p-4">
						<pre className="whitespace-pre-wrap font-mono text-sm text-destructive">
							{state.error}
						</pre>
					</TabsContent>
				)}
			</Tabs>
		);
	}

	// Hidden / extracting-spec: empty workspace
	return (
		<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
			<div className="text-center">
				<DnaIcon className="mx-auto mb-2 size-8 opacity-20" />
				<p>Workspace</p>
				<p className="text-xs opacity-60">Your project will appear here</p>
			</div>
		</div>
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
	const [specRejected, setSpecRejected] = useState(false);
	const [attachments, setAttachments] = useState<AttachmentData[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const autoSubmittedRef = useRef(false);

	// Agent connection: state channel (spec, files, spawnId, workspaceStatus)
	const [agentName] = useState(() => crypto.randomUUID());
	const agent = useAgent<SpawnAgentState>({
		agent: "SpawnAgent",
		name: agentName,
		onStateUpdate: setState,
	});

	// Chat channel: messages, status, tool parts
	const { messages, sendMessage, status, clearHistory } = useAgentChat({
		agent,
		getInitialMessages: null,
	});

	const phase = state?.status ?? "idle";
	const isWorking = status === "streaming" || status === "submitted";
	const isComplete = phase === "complete";
	const showSplitPanel = phase !== "idle" && phase !== "extracting-spec";

	// Reset specRejected when phase leaves awaiting-approval
	useEffect(() => {
		if (phase !== "awaiting-approval") {
			setSpecRejected(false);
		}
	}, [phase]);

	// ── Actions ─────────────────────────────────────────────────────────

	const handleSubmit = useCallback(
		({ text }: { text: string }) => {
			if (!text.trim() || isWorking) return;
			sendMessage({ text });
			setPrompt("");
			setSelectedFile(null);
		},
		[isWorking, sendMessage],
	);

	const handleRetry = useCallback(() => {
		if (isWorking) return;
		const originalPrompt = getTextContent(messages[0]);
		if (!originalPrompt) return;

		agent.send(JSON.stringify({ type: "reset" }));
		clearHistory();
		setRetryPending(false);
		setSpecRejected(false);

		setTimeout(() => sendMessage({ text: originalPrompt }), 150);
	}, [isWorking, messages, agent, clearHistory, sendMessage]);

	const handleSuggestion = useCallback((suggestion: string) => {
		setPrompt(suggestion);
	}, []);

	const handleApprove = useCallback(() => {
		handleSubmit({ text: "approved" });
	}, [handleSubmit]);

	const handleReject = useCallback(() => {
		setSpecRejected(true);
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

	const handleDownload = useCallback(() => {
		const content = JSON.stringify(state?.files ?? {}, null, 2);
		const blob = new Blob([content], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${state?.spec?.name ?? "spawn"}-files.json`;
		a.click();
		URL.revokeObjectURL(url);
	}, [state?.files, state?.spec?.name]);

	// ── Derived state ───────────────────────────────────────────────────

	const hasMessages = messages.length > 0;
	const showEmpty = phase === "idle" && !hasMessages;
	const quickStartSuggestions = useMemo(() => getRotatingQuickStartSuggestions(3), []);
	const filePaths = Object.keys(state?.files ?? {});

	const firstUserMessage = messages.find((m) => m.role === "user");
	const approvalIndex = messages.findIndex(
		(m) => m.role === "user" && getTextContent(m) === "approved",
	);
	const buildMessages = messages.slice(approvalIndex + 1).filter((m) => m.role === "assistant");

	// ── Prompt Input (shared across layouts) ────────────────────────────

	const promptInput = (
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
					phase === "awaiting-approval" && specRejected
						? "Describe changes to the spec..."
						: isComplete
							? "Give feedback to improve the project..."
							: "Describe the software you want to create..."
				}
				value={prompt}
				onChange={(e) => setPrompt(e.target.value)}
				disabled={
					phase === "extracting-spec" ||
					phase === "building" ||
					(phase === "awaiting-approval" && !specRejected)
				}
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
					<PromptInputSubmit disabled={isWorking || !prompt.trim()} />
				</div>
			</PromptInputFooter>
		</PromptInput>
	);

	// ── Idle layout: centered single column ─────────────────────────────

	if (!showSplitPanel) {
		return (
			<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-end gap-6 p-6">
				<Conversation className={showEmpty ? "" : "min-h-[200px] rounded-lg border"}>
					<ConversationContent>
						{showEmpty && (
							<ConversationEmptyState
								title="What do you want to build?"
								description="Describe your software idea and we'll build it iteratively."
								icon={<DnaIcon className="size-8" />}
							/>
						)}
						{firstUserMessage && (
							<Message from="user">
								<MessageContent>{getTextContent(firstUserMessage)}</MessageContent>
							</Message>
						)}
						{phase === "extracting-spec" && (
							<Message from="assistant">
								<MessageContent>
									<Reasoning isStreaming defaultOpen>
										<ReasoningTrigger
											getThinkingMessage={() => (
												<Shimmer duration={1}>Analysing your request...</Shimmer>
											)}
										/>
									</Reasoning>
								</MessageContent>
							</Message>
						)}
					</ConversationContent>
				</Conversation>

				{showEmpty && (
					<Suggestions className="pb-2">
						{quickStartSuggestions.map((suggestion) => (
							<Suggestion key={suggestion} suggestion={suggestion} onClick={handleSuggestion} />
						))}
					</Suggestions>
				)}

				{promptInput}
			</div>
		);
	}

	// ── Active layout: resizable split (chat left, workspace right) ─────

	return (
		<ResizablePanelGroup orientation="horizontal" className="h-full">
			{/* ── Left: Chat panel ── */}
			<ResizablePanel defaultSize={45} minSize={30}>
				<div className="flex h-full flex-col">
					<Conversation className="flex-1">
						<ConversationContent>
							{/* User's original prompt */}
							{firstUserMessage && (
								<Message from="user">
									<MessageContent>{getTextContent(firstUserMessage)}</MessageContent>
								</Message>
							)}

							{/* Phase: awaiting-approval → model summary */}
							{phase === "awaiting-approval" &&
								state?.spec &&
								messages
									.filter((m) => m.role === "assistant")
									.map((m) => (
										<Message key={m.id} from="assistant">
											<MessageContent>
												<MessageResponse>{getTextContent(m)}</MessageResponse>
											</MessageContent>
										</Message>
									))}

							{/* Phases: building / complete / failed → checkpoint + reasoning + tools */}
							{state?.spec &&
								(phase === "building" || phase === "complete" || phase === "failed") && (
									<>
										<Checkpoint>
											<CheckpointIcon />
											<CheckpointTrigger>Spec Approved</CheckpointTrigger>
										</Checkpoint>

										{/* Chain-of-thought reasoning (multi-step, latest with Shimmer) */}
										{state.reasoning && state.reasoning.length > 0 && (
											<Message from="assistant">
												<MessageContent>
													<ChainOfThought defaultOpen>
														<ChainOfThoughtHeader>Thinking</ChainOfThoughtHeader>
														<ChainOfThoughtContent>
															{state.reasoning.map((step, i) => (
																<ChainOfThoughtStep
																	key={step}
																	status={
																		i === state.reasoning.length - 1 && phase === "building"
																			? "active"
																			: "complete"
																	}
																	label={
																		i === state.reasoning.length - 1 && phase === "building" ? (
																			<Shimmer duration={1}>{step}</Shimmer>
																		) : (
																			step
																		)
																	}
																/>
															))}
														</ChainOfThoughtContent>
													</ChainOfThought>
												</MessageContent>
											</Message>
										)}

										{/* Tool call messages from the build stream */}
										{buildMessages
											.filter((m) =>
												m.parts.some(
													(p) => (p.type === "text" && p.text.trim()) || p.type === "dynamic-tool",
												),
											)
											.map((message) => (
												<Message key={message.id} from="assistant">
													<MessageContent>
														{message.parts.map((part) => {
															if (part.type === "text" && part.text.trim()) {
																return (
																	<MessageResponse key={`${message.id}-text`}>
																		{part.text}
																	</MessageResponse>
																);
															}
															if (part.type === "dynamic-tool") {
																return <ToolPart key={part.toolCallId} part={part} />;
															}
															return null;
														})}
													</MessageContent>
												</Message>
											))}
									</>
								)}

							{/* Phase: complete → Commit summary + actions */}
							{isComplete && filePaths.length > 0 && (
								<>
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
													{state?.spawnId && (
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
									<Checkpoint>
										<CheckpointIcon />
										<CheckpointTrigger>Ready for Review</CheckpointTrigger>
									</Checkpoint>
								</>
							)}

							{/* Phase: failed → error inline */}
							{phase === "failed" && state?.error && (
								<Message from="assistant">
									<MessageContent>
										<div className="flex items-start justify-between text-sm text-destructive">
											<span>
												<strong>Error:</strong> {state.error}
											</span>
											<Button variant="ghost" size="sm" onClick={handleRetry}>
												<RefreshCwIcon className="mr-1 size-3" />
												Retry
											</Button>
										</div>
									</MessageContent>
								</Message>
							)}

							{/* Phase: complete → run snippet */}
							{isComplete && state?.files?.["package.json"] && (
								<Snippet code="npm install && npm start">
									<SnippetInput />
									<SnippetCopyButton />
								</Snippet>
							)}
						</ConversationContent>
					</Conversation>

					{/* Task panel — only when tasks exist */}
					{state?.tasks && state.tasks.length > 0 && <TaskPanel tasks={state.tasks} />}

					{/* Prompt input pinned at bottom */}
					<div className="shrink-0 border-t p-3">{promptInput}</div>
				</div>
			</ResizablePanel>

			{/* ── Resize handle ── */}
			<ResizableHandle withHandle />

			{/* ── Right: Workspace panel ── */}
			<ResizablePanel defaultSize={55} minSize={30}>
				{state ? (
					<WorkspacePanel
						state={state}
						selectedFile={selectedFile}
						onSelectFile={setSelectedFile}
						onApprove={handleApprove}
						onReject={handleReject}
						onDownload={handleDownload}
					/>
				) : (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Connecting...
					</div>
				)}
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
