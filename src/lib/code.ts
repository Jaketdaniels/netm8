import type { BundledLanguage } from "shiki";

const EXT_MAP: Record<string, BundledLanguage> = {
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

export function extToLanguage(path: string): BundledLanguage {
	const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
	return EXT_MAP[ext] ?? "text";
}

export function buildFolderTree<T extends { path: string }>(items: T[]) {
	const tree: Record<string, T[]> = {};
	const rootFiles: T[] = [];
	for (const item of items) {
		const parts = item.path.split("/");
		if (parts.length === 1) {
			rootFiles.push(item);
		} else {
			const folder = parts[0];
			if (!tree[folder]) tree[folder] = [];
			tree[folder].push(item);
		}
	}
	return { tree, rootFiles };
}
