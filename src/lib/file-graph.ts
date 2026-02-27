import type { Edge, Node } from "@xyflow/react";

const IMPORT_RE =
	/(?:import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const COLS = 3;
const X_GAP = 280;
const Y_GAP = 120;

export function parseImports(content: string): string[] {
	const imports: string[] = [];
	for (const match of content.matchAll(IMPORT_RE)) {
		const specifier = match[1] ?? match[2];
		if (specifier?.startsWith(".")) {
			imports.push(specifier);
		}
	}
	return imports;
}

export function resolveImport(
	importPath: string,
	sourceFile: string,
	allFiles: string[],
): string | null {
	const sourceDir = sourceFile.includes("/")
		? sourceFile.slice(0, sourceFile.lastIndexOf("/"))
		: "";

	const resolved = sourceDir ? `${sourceDir}/${importPath}` : importPath;
	const normalized = resolved.replace(/\/\.\//g, "/").replace(/^\.\//, "");

	const candidates = [
		normalized,
		`${normalized}.ts`,
		`${normalized}.tsx`,
		`${normalized}.js`,
		`${normalized}.jsx`,
		`${normalized}/index.ts`,
		`${normalized}/index.tsx`,
		`${normalized}/index.js`,
	];

	return candidates.find((c) => allFiles.includes(c)) ?? null;
}

function gridLayout(index: number, _total: number): { x: number; y: number } {
	const col = index % COLS;
	const row = Math.floor(index / COLS);
	return { x: col * X_GAP, y: row * Y_GAP };
}

function extToLanguage(path: string): string {
	const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		json: "json",
		css: "css",
		html: "html",
	};
	return map[ext] ?? "text";
}

export function buildFileGraph(files: Array<{ path: string; content: string }>): {
	nodes: Node[];
	edges: Edge[];
} {
	const allPaths = files.map((f) => f.path);

	const nodes: Node[] = files.map((f, i) => ({
		id: f.path,
		type: "file",
		position: gridLayout(i, files.length),
		data: {
			label: f.path.split("/").pop() ?? f.path,
			fullPath: f.path,
			language: extToLanguage(f.path),
		},
	}));

	const edges: Edge[] = [];
	for (const file of files) {
		for (const imp of parseImports(file.content)) {
			const resolved = resolveImport(imp, file.path, allPaths);
			if (resolved) {
				edges.push({
					id: `${file.path}->${resolved}`,
					source: file.path,
					target: resolved,
					type: "animated",
				});
			}
		}
	}

	return { nodes, edges };
}
