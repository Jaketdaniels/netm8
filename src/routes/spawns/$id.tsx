import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { BundledLanguage } from "shiki";
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockCopyButton,
	CodeBlockFilename,
	CodeBlockHeader,
	CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/spawns/$id")({
	component: SpawnDetail,
});

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
	files: SpawnFile[];
}

function extToLanguage(path: string): BundledLanguage {
	const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
	const map: Record<string, BundledLanguage> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		json: "json",
		css: "css",
		html: "html",
		md: "markdown",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		py: "python",
		rs: "rust",
		go: "go",
		sh: "bash",
		sql: "sql",
	};
	return map[ext] ?? "text";
}

function statusVariant(status: string) {
	if (status === "complete") return "default" as const;
	if (status === "failed") return "destructive" as const;
	return "secondary" as const;
}

function buildFolderTree(files: SpawnFile[]) {
	const tree: Record<string, SpawnFile[]> = {};
	const rootFiles: SpawnFile[] = [];
	for (const f of files) {
		const parts = f.path.split("/");
		if (parts.length === 1) {
			rootFiles.push(f);
		} else {
			const folder = parts[0];
			if (!tree[folder]) tree[folder] = [];
			tree[folder].push(f);
		}
	}
	return { tree, rootFiles };
}

function SpawnDetail() {
	const { id } = Route.useParams();
	const [selectedFile, setSelectedFile] = useState<string | null>(null);

	const { data, isLoading, error } = useQuery({
		queryKey: ["spawn", id],
		queryFn: async () => {
			const res = await fetch(`/api/spawns/${id}`);
			if (!res.ok) throw new Error("Spawn not found");
			return res.json() as Promise<SpawnDetailData>;
		},
	});

	if (isLoading)
		return (
			<div className="flex min-h-screen items-center justify-center">
				<p className="text-sm text-muted-foreground">Loading...</p>
			</div>
		);
	if (error)
		return (
			<div className="flex min-h-screen items-center justify-center">
				<p className="text-sm text-destructive-foreground">Error: {error.message}</p>
			</div>
		);
	if (!data) return null;

	const features: string[] = data.features ? JSON.parse(data.features) : [];
	const activeFile = data.files.find((f) => f.path === selectedFile) ?? data.files[0];
	const { tree, rootFiles } = buildFolderTree(data.files);

	return (
		<div className="mx-auto min-h-screen max-w-6xl p-6">
			{/* Breadcrumb + header */}
			<header className="mb-6">
				<nav className="mb-2 flex items-center gap-1 text-sm text-muted-foreground">
					<a href="/" className="hover:text-foreground">
						netm8
					</a>
					<span>/</span>
					<Link to="/spawns" className="hover:text-foreground">
						spawns
					</Link>
					<span>/</span>
					<span className="text-foreground">{data.name ?? id.slice(0, 8)}</span>
				</nav>
				<div className="flex items-start justify-between">
					<div>
						<h1 className="text-2xl font-bold">{data.name ?? "Unnamed Project"}</h1>
						{data.description && <p className="mt-1 text-muted-foreground">{data.description}</p>}
					</div>
					<Badge variant={statusVariant(data.status)} className="text-xs uppercase">
						{data.status}
					</Badge>
				</div>
			</header>

			{/* Tags */}
			<div className="mb-6 flex flex-wrap gap-2">
				{data.platform && <Badge variant="outline">{data.platform}</Badge>}
				{features.map((f) => (
					<Badge key={f} variant="secondary">
						{f}
					</Badge>
				))}
			</div>

			{/* Error */}
			{data.error && (
				<div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive-foreground">
					<strong>Error:</strong> {data.error}
				</div>
			)}

			{/* Prompt */}
			<Card className="mb-6">
				<CardHeader className="pb-2">
					<CardTitle className="text-sm font-semibold text-muted-foreground">Prompt</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="italic text-muted-foreground">{data.prompt}</p>
				</CardContent>
			</Card>

			{/* File Browser */}
			{data.files.length > 0 && (
				<div>
					<h3 className="mb-3 text-sm font-semibold text-muted-foreground">
						Files ({data.files.length})
					</h3>
					<div className="flex gap-4 overflow-hidden rounded-lg border">
						{/* Sidebar */}
						<div className="w-56 shrink-0 border-r p-2">
							<FileTree
								selectedPath={activeFile?.path}
								onSelect={((path: string) => setSelectedFile(path)) as any}
								defaultExpanded={new Set(Object.keys(tree))}
							>
								{Object.entries(tree).map(([folder, files]) => (
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
								{rootFiles.map((f) => (
									<FileTreeFile key={f.path} path={f.path} name={f.path} />
								))}
							</FileTree>
						</div>

						{/* Code panel */}
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
				</div>
			)}
		</div>
	);
}
