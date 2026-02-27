import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircleIcon, DnaIcon, DownloadIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useMemo, useState } from "react";
import {
	Artifact,
	ArtifactAction,
	ArtifactActions,
	ArtifactContent,
	ArtifactHeader,
	ArtifactTitle,
} from "@/components/ai-elements/artifact";
import {
	ChainOfThought,
	ChainOfThoughtContent,
	ChainOfThoughtHeader,
	ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
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
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
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
	PackageInfo,
	PackageInfoContent,
	PackageInfoDependencies,
	PackageInfoDependency,
	PackageInfoDescription,
	PackageInfoHeader,
	PackageInfoName,
	PackageInfoVersion,
} from "@/components/ai-elements/package-info";
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
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Snippet, SnippetCopyButton, SnippetInput } from "@/components/ai-elements/snippet";
import {
	StackTrace,
	StackTraceActions,
	StackTraceContent,
	StackTraceCopyButton,
	StackTraceError,
	StackTraceErrorMessage,
	StackTraceErrorType,
	StackTraceExpandButton,
	StackTraceFrames,
	StackTraceHeader,
} from "@/components/ai-elements/stack-trace";
import {
	Terminal,
	TerminalActions,
	TerminalContent,
	TerminalCopyButton,
	TerminalHeader,
	TerminalTitle,
} from "@/components/ai-elements/terminal";
import {
	TestResults,
	TestResultsContent,
	TestResultsHeader,
	TestResultsSummary as TestResultsSummaryDisplay,
	TestSuite,
	TestSuiteName,
} from "@/components/ai-elements/test-results";
import {
	WebPreview,
	WebPreviewBody,
	WebPreviewNavigation,
	WebPreviewUrl,
} from "@/components/ai-elements/web-preview";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildFolderTree, extToLanguage } from "@/lib/code";
import { fadeUp, stagger } from "@/lib/motion";
import { api } from "../../api";

// ── Route ───────────────────────────────────────────────────────────────

export const Route = createFileRoute("/spawn/$id")({
	component: SpawnDetailPage,
});

// ── Types ───────────────────────────────────────────────────────────────

interface SpawnFile {
	id: string;
	path: string;
	content: string;
	language: string | null;
}

interface SpawnDetailData {
	id: string;
	prompt: string;
	name: string | null;
	description: string | null;
	platform: string | null;
	features: string | null;
	status: string;
	error: string | null;
	buildLog: string | null;
	files: SpawnFile[];
}

// ── Component ───────────────────────────────────────────────────────────

function SpawnDetailPage() {
	const { id } = Route.useParams();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [selectedFile, setSelectedFile] = useState<string | null>(null);

	const { data, isLoading, error } = useQuery({
		queryKey: ["spawn", id],
		queryFn: async () => {
			const res = await api.api.spawns[":id"].$get({ param: { id } });
			if (!res.ok) throw new Error("Spawn not found");
			return res.json() as Promise<SpawnDetailData>;
		},
	});

	const features: string[] = useMemo(
		() => (data?.features ? JSON.parse(data.features) : []),
		[data?.features],
	);

	const packageJson = useMemo(() => {
		if (!data) return null;
		const pkgFile = data.files.find((f) => f.path === "package.json");
		if (!pkgFile) return null;
		try {
			return JSON.parse(pkgFile.content) as {
				name?: string;
				version?: string;
				description?: string;
				dependencies?: Record<string, string>;
			};
		} catch {
			return null;
		}
	}, [data]);

	const htmlBlobUrl = useMemo(() => {
		if (!data) return null;
		const htmlFile = data.files.find((f) => f.path === "index.html");
		if (!htmlFile) return null;
		const blob = new Blob([htmlFile.content], { type: "text/html" });
		return URL.createObjectURL(blob);
	}, [data]);

	const testResults = useMemo(() => {
		if (!data?.buildLog) return null;
		const passMatch = data.buildLog.match(/(\d+)\s+(?:passing|passed)/i);
		const failMatch = data.buildLog.match(/(\d+)\s+(?:failing|failed)/i);
		const skipMatch = data.buildLog.match(/(\d+)\s+(?:pending|skipped)/i);
		const passed = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
		const failed = failMatch ? Number.parseInt(failMatch[1], 10) : 0;
		const skipped = skipMatch ? Number.parseInt(skipMatch[1], 10) : 0;
		const total = passed + failed + skipped;
		if (total === 0) return null;
		return {
			summary: { passed, failed, skipped, total },
			suites: [
				{ name: "Test Suite", status: (failed > 0 ? "failed" : "passed") as "passed" | "failed" },
			],
		};
	}, [data?.buildLog]);

	const filePaths = data?.files.map((f) => f.path) ?? [];
	const activeFilePath = selectedFile ?? filePaths[0] ?? null;
	const activeFile = data?.files.find((f) => f.path === activeFilePath);
	const folderTree = filePaths.length > 0 ? buildFolderTree(data?.files ?? []) : null;
	const hasPackageJson = filePaths.includes("package.json");

	const handleDownload = () => {
		if (!data) return;
		for (const file of data.files) {
			const blob = new Blob([file.content], { type: "text/plain" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = file.path;
			a.click();
			URL.revokeObjectURL(url);
		}
	};

	const handleDelete = useCallback(async () => {
		const res = await api.api.spawns[":id"].$delete({ param: { id } });
		if (res.ok) {
			queryClient.invalidateQueries({ queryKey: ["spawns"] });
			navigate({ to: "/spawn" });
		}
	}, [id, navigate, queryClient]);

	if (isLoading) {
		return (
			<div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-6 p-6">
				<Shimmer className="text-sm">Loading project...</Shimmer>
			</div>
		);
	}

	if (error) {
		return (
			<div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-6 p-6">
				<p className="text-sm text-destructive-foreground">Error: {error.message}</p>
			</div>
		);
	}

	if (!data) return null;

	return (
		<motion.div
			className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-6"
			initial="hidden"
			animate="visible"
			variants={stagger}
		>
			{/* Header — title + actions */}
			<motion.div variants={fadeUp} className="flex items-center justify-between">
				<h1 className="font-display text-xl font-bold tracking-tight">{data.name ?? "Spawn"}</h1>
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button variant="ghost" size="sm" className="text-muted-foreground">
							<Trash2Icon className="mr-1.5 size-3.5" />
							Delete
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete this spawn?</AlertDialogTitle>
							<AlertDialogDescription>
								This will permanently delete the spawn and all its generated files. This action
								cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</motion.div>

			{/* Error — StackTrace */}
			{data.error && (
				<motion.div variants={fadeUp}>
					<StackTrace trace={data.error} defaultOpen>
						<StackTraceHeader>
							<StackTraceError>
								<StackTraceErrorType />
								<StackTraceErrorMessage />
							</StackTraceError>
							<StackTraceActions>
								<StackTraceCopyButton />
								<StackTraceExpandButton />
							</StackTraceActions>
						</StackTraceHeader>
						<StackTraceContent>
							<StackTraceFrames />
						</StackTraceContent>
					</StackTrace>
				</motion.div>
			)}

			{/* Conversation — shows the project's build context */}
			<motion.div variants={fadeUp}>
				<Conversation className="min-h-[200px] rounded-lg border">
					<ConversationContent>
						{/* User prompt */}
						<Message from="user">
							<MessageContent>{data.prompt}</MessageContent>
						</Message>

						{/* Plan — from spec data */}
						{(data.name || data.description) && (
							<Message from="assistant">
								<MessageContent>
									<Plan defaultOpen>
										<PlanHeader>
											<div className="flex-1">
												<PlanTitle>{data.name ?? "Project"}</PlanTitle>
												{data.description && <PlanDescription>{data.description}</PlanDescription>}
											</div>
											<PlanTrigger />
										</PlanHeader>
										<PlanContent>
											<div className="flex flex-wrap gap-2">
												{data.platform && <Badge variant="default">{data.platform}</Badge>}
												{features.map((f) => (
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

						{/* Build result */}
						<Message from="assistant">
							<MessageContent>
								<ChainOfThought defaultOpen={false}>
									<ChainOfThoughtHeader>Build History</ChainOfThoughtHeader>
									<ChainOfThoughtContent>
										<ChainOfThoughtStep
											status={
												data.status === "complete" || data.status === "failed"
													? "complete"
													: "active"
											}
											label={
												data.status === "complete"
													? `Build completed — ${data.files.length} file${data.files.length !== 1 ? "s" : ""}`
													: data.status === "failed"
														? "Build failed"
														: "Build in progress"
											}
											icon={
												data.status === "complete"
													? CheckCircleIcon
													: data.status === "failed"
														? Trash2Icon
														: Loader2Icon
											}
										/>
									</ChainOfThoughtContent>
								</ChainOfThought>
							</MessageContent>
						</Message>

						{/* Commit summary */}
						{data.status === "complete" && data.files.length > 0 && (
							<Message from="assistant">
								<MessageContent>
									<Commit defaultOpen>
										<CommitHeader>
											<CommitInfo>
												<CommitMessage>
													{data.files.length} file{data.files.length !== 1 ? "s" : ""} generated
												</CommitMessage>
											</CommitInfo>
										</CommitHeader>
										<CommitContent>
											<CommitFiles>
												{data.files.map((file) => (
													<CommitFile key={file.path}>
														<CommitFileInfo>
															<CommitFileStatus status="added" />
															<CommitFileIcon />
															<CommitFilePath>{file.path}</CommitFilePath>
														</CommitFileInfo>
													</CommitFile>
												))}
											</CommitFiles>
										</CommitContent>
									</Commit>
								</MessageContent>
							</Message>
						)}
					</ConversationContent>
				</Conversation>
			</motion.div>

			{/* Prompt — start new spawn with context */}
			<PromptInput onSubmit={() => {}} className="sticky bottom-6">
				<PromptInputTextarea
					placeholder="Describe changes to iterate on this project..."
					disabled
				/>
				<PromptInputFooter>
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<DnaIcon className="size-3" />
						<span>
							<Link to="/spawn" className="text-primary hover:underline">
								Start a new spawn
							</Link>{" "}
							to iterate
						</span>
					</div>
					<PromptInputSubmit disabled />
				</PromptInputFooter>
			</PromptInput>

			{/* Terminal — real build output */}
			{data.buildLog && (
				<motion.div variants={fadeUp}>
					<Terminal output={data.buildLog}>
						<TerminalHeader>
							<TerminalTitle>Build Output</TerminalTitle>
							<TerminalActions>
								<TerminalCopyButton />
							</TerminalActions>
						</TerminalHeader>
						<TerminalContent />
					</Terminal>
				</motion.div>
			)}

			{/* Test Results — parsed from build log */}
			{testResults && (
				<motion.div variants={fadeUp}>
					<TestResults summary={testResults.summary}>
						<TestResultsHeader>
							<TestResultsSummaryDisplay />
						</TestResultsHeader>
						<TestResultsContent>
							{testResults.suites.map((suite) => (
								<TestSuite key={suite.name} name={suite.name} status={suite.status}>
									<TestSuiteName />
								</TestSuite>
							))}
						</TestResultsContent>
					</TestResults>
				</motion.div>
			)}

			{/* Artifact (file browser) */}
			{filePaths.length > 0 && folderTree && (
				<motion.div variants={fadeUp}>
					<Artifact>
						<ArtifactHeader>
							<ArtifactTitle>
								{filePaths.length} file{filePaths.length !== 1 ? "s" : ""} generated
							</ArtifactTitle>
							<ArtifactActions>
								<OpenIn query={`Review code for ${data.name ?? "this project"}`}>
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
										onSelect={((path: string) => setSelectedFile(path)) as any}
										defaultExpanded={new Set(Object.keys(folderTree.tree))}
									>
										{Object.entries(folderTree.tree).map(([folder, files]) => (
											<FileTreeFolder key={folder} path={folder} name={folder}>
												{files.map((f) => (
													<FileTreeFile
														key={f.path}
														path={f.path}
														name={f.path.split("/").pop() ?? f.path}
													/>
												))}
											</FileTreeFolder>
										))}
										{folderTree.rootFiles.map((f) => (
											<FileTreeFile key={f.path} path={f.path} name={f.path} />
										))}
									</FileTree>
								</div>
								<div className="min-w-0 flex-1">
									{activeFile && (
										<CodeBlock
											code={activeFile.content}
											language={extToLanguage(activeFile.path)}
											className="rounded-none border-0"
										>
											<CodeBlockHeader>
												<CodeBlockTitle>
													<CodeBlockFilename>{activeFile.path}</CodeBlockFilename>
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
				</motion.div>
			)}

			{/* Run commands */}
			{hasPackageJson && (
				<Snippet code="npm install && npm start">
					<SnippetInput />
					<SnippetCopyButton />
				</Snippet>
			)}

			{/* WebPreview — if index.html exists */}
			{htmlBlobUrl && (
				<div>
					<h3 className="mb-3 text-sm font-semibold text-muted-foreground">Preview</h3>
					<WebPreview defaultUrl={htmlBlobUrl} className="h-[500px]">
						<WebPreviewNavigation>
							<WebPreviewUrl />
						</WebPreviewNavigation>
						<WebPreviewBody />
					</WebPreview>
				</div>
			)}

			{/* PackageInfo */}
			{packageJson && (
				<PackageInfo name={packageJson.name ?? "unknown"} currentVersion={packageJson.version}>
					<PackageInfoHeader>
						<PackageInfoName />
					</PackageInfoHeader>
					{packageJson.version && <PackageInfoVersion />}
					{packageJson.description && (
						<PackageInfoDescription>{packageJson.description}</PackageInfoDescription>
					)}
					{packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0 && (
						<PackageInfoContent>
							<PackageInfoDependencies>
								{Object.entries(packageJson.dependencies).map(([dep, ver]) => (
									<PackageInfoDependency key={dep} name={dep} version={ver} />
								))}
							</PackageInfoDependencies>
						</PackageInfoContent>
					)}
				</PackageInfo>
			)}
		</motion.div>
	);
}
