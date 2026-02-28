/// <reference types="../../worker-configuration.d.ts" />

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type {
	LanguageModelMiddleware,
	StopCondition,
	StreamTextOnFinishCallback,
	ToolCallRepairFunction,
	ToolSet,
} from "ai";
import { stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { type SpecResult, SpecResultSchema } from "../../src/shared/schemas";

// ── Model ───────────────────────────────────────────────────────────────

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const MAX_STEPS = 20;
export type RunProjectStreamMode = "initial" | "feedback";
const SCAFFOLD_TEMPLATE_TYPES = ["fullstack", "api"] as const;
type ScaffoldTemplateType = (typeof SCAFFOLD_TEMPLATE_TYPES)[number];
export const BUILD_TOOL_NAMES = [
	"fetch_scaffold",
	"write_file",
	"read_file",
	"edit_file",
	"exec",
	"done",
] as const;
type BuildToolName = (typeof BUILD_TOOL_NAMES)[number];

const TOOL_INPUT_SCHEMAS = {
	fetch_scaffold: z.object({
		projectName: z
			.string()
			.min(1)
			.describe("Project name used for package metadata and template placeholders"),
		templateType: z
			.enum(SCAFFOLD_TEMPLATE_TYPES)
			.describe("Template family to scaffold first: fullstack or api"),
	}),
	write_file: z.object({
		fileName: z.string().min(1).describe("Relative file path (e.g. src/index.ts)"),
		fileType: z.string().min(1).describe("File type or extension (e.g. ts, tsx, json, css)"),
		fileBody: z.string().min(1).describe("Full file content"),
	}),
	read_file: z.object({
		fileName: z.string().min(1).describe("Relative file path to read"),
	}),
	edit_file: z.object({
		fileName: z.string().min(1).describe("Relative file path to edit"),
		existingCode: z
			.string()
			.min(1)
			.describe("Exact code snippet to replace (must match existing file content)"),
		replacementCode: z.string().describe("Replacement code snippet"),
	}),
	exec: z.object({
		command: z.string().min(1).describe("Shell command to execute"),
	}),
	done: z.object({
		summary: z.string().min(1).describe("Brief summary of what was built"),
	}),
} as const;

type BuildToolInputSchemas = typeof TOOL_INPUT_SCHEMAS;
type BuildToolArgs<TName extends BuildToolName> = z.infer<BuildToolInputSchemas[TName]>;

const TOOL_DESCRIPTIONS: Record<BuildToolName, string> = {
	fetch_scaffold:
		"Fetch a starter template and write it into /workspace. Required first step before any custom coding.",
	write_file:
		"Create or overwrite a file in /workspace using fileName/fileType/fileBody. All fields are required.",
	read_file: "Read the contents of a file in /workspace using fileName.",
	edit_file:
		"Edit an existing file by exact-code replacement. Requires fileName, existingCode, replacementCode.",
	exec: "Execute a shell command in the workspace. Use for npm install, npm test, build commands, etc.",
	done: "Signal that the project is complete. Call this when all files are written, tests pass, and the project is ready.",
};

function isBuildToolName(name: string): name is BuildToolName {
	return (BUILD_TOOL_NAMES as readonly string[]).includes(name);
}

type ToolCatalogProperty = {
	type: string;
	description?: string;
	default?: unknown;
};

type ToolCatalogEntry = {
	name: BuildToolName;
	description: string;
	parameters: {
		type: "dict";
		required: string[];
		properties: Record<string, ToolCatalogProperty>;
	};
};

function buildToolCatalog(): ToolCatalogEntry[] {
	return BUILD_TOOL_NAMES.map((toolName) => {
		const schema = z.toJSONSchema(TOOL_INPUT_SCHEMAS[toolName]) as {
			required?: string[];
			properties?: Record<string, { type?: unknown; description?: unknown; default?: unknown }>;
		};

		const properties: Record<string, ToolCatalogProperty> = {};
		for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
			const rawType = propertySchema.type;
			const normalizedType =
				Array.isArray(rawType) && rawType.length > 0
					? String(rawType[0])
					: typeof rawType === "string"
						? rawType
						: "string";

			properties[propertyName] = {
				type: normalizedType,
				description:
					typeof propertySchema.description === "string" ? propertySchema.description : undefined,
				default: propertySchema.default,
			};
		}

		return {
			name: toolName,
			description: TOOL_DESCRIPTIONS[toolName],
			parameters: {
				type: "dict",
				required: schema.required ?? [],
				properties,
			},
		};
	});
}

function buildToolCatalogJson(): string {
	return JSON.stringify(buildToolCatalog(), null, 4);
}

// ── Spec (one-shot, unchanged) ──────────────────────────────────────────

function extractResponse(result: unknown): string | object {
	if (result instanceof ReadableStream) {
		throw new Error("Unexpected stream response — use non-streaming mode");
	}
	const response = (result as { response?: string | object | null }).response;
	if (!response) throw new Error("Workers AI returned an empty response");
	return response;
}

export async function extractSpec(ai: Ai, prompt: string): Promise<SpecResult> {
	const system = `You are a software architect. Given a natural language description, extract a structured specification as JSON.
Output a JSON object with exactly these fields:
- "name": short kebab-case identifier (e.g. "todo-app")
- "description": single sentence describing the project
- "platform": one of "ios", "android", "web", "desktop", "cli", "api"
- "features": array of 3-8 distinct feature strings
- "summary": 2-3 sentences addressed to the user explaining what you understood from their request, what you'll build, and the key features. Write conversationally (e.g. "I'll build a REST API that…"). End by telling them to review the plan and start building, or describe any changes.
Output ONLY valid JSON, no extra text.`;

	const result = await ai.run(MODEL, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: prompt },
		],
		max_tokens: 1024,
	});

	const raw = extractResponse(result);
	const text = typeof raw === "string" ? raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim() : raw;
	const json = typeof text === "string" ? JSON.parse(text) : text;
	const parsed = SpecResultSchema.safeParse(json);

	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		throw new Error(`AI response failed validation: ${issues}`);
	}

	return parsed.data;
}

// ── Scaffold Templates ─────────────────────────────────────────────────

type ScaffoldBundle = {
	templateType: ScaffoldTemplateType;
	source?: {
		repository?: string;
		templatePath?: string;
		generatedAt?: string;
	};
	files: Record<string, string>;
};

function normalizeProjectName(projectName: string): string {
	const normalized = projectName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-_]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "netm8-app";
}

function applyProjectName(content: string, projectName: string): string {
	return content.replaceAll("__PROJECT_NAME__", projectName);
}

function mapTemplateFiles(
	files: Record<string, string>,
	projectName: string,
): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [path, content] of Object.entries(files)) {
		output[path] = applyProjectName(content, projectName);
	}
	return output;
}

const FALLBACK_SCAFFOLDS: Record<ScaffoldTemplateType, ScaffoldBundle> = {
	fullstack: {
		templateType: "fullstack",
		source: {
			repository: "https://github.com/cloudflare/workers-sdk",
			templatePath: "packages/create-cloudflare/templates/react/workers + netm8 overlay",
			generatedAt: "2026-02-28",
		},
		files: {
			"package.json": `{
  "name": "__PROJECT_NAME__",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "cf-typegen": "wrangler types"
  },
  "dependencies": {
    "@hono/zod-validator": "^0.7.6",
    "@tanstack/react-query": "^5.90.21",
    "better-auth": "^1.3.0",
    "hono": "^4.12.3",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.25.6",
    "@types/node": "^25.3.2",
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.1",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.575.0",
    "tailwind-merge": "^3.5.0",
    "typescript": "^5.9.3",
    "vite": "^7.3.1",
    "wrangler": "^4.69.0"
  }
}`,
			"README.md": `# __PROJECT_NAME__

Cloudflare Workers + Vite full-stack starter scaffold with:
- React
- Hono
- Zod
- Better Auth
- TanStack Query
- shadcn/ui-compatible utility setup

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`
`,
			"index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>__PROJECT_NAME__</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
			"vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
});
`,
			"tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["vite/client", "./worker-configuration.d.ts"]
  },
  "include": ["src", "worker"]
}
`,
			"wrangler.jsonc": `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "__PROJECT_NAME__",
  "main": "worker/index.ts",
  "compatibility_date": "2026-02-28",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist",
    "not_found_handling": "single-page-application",
    "binding": "ASSETS"
  }
}
`,
			"worker/index.ts": `import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/api/health", (c) => {
  return c.json({
    ok: true,
    app: "__PROJECT_NAME__",
    timestamp: new Date().toISOString(),
  });
});

app.post(
  "/api/echo",
  zValidator(
    "json",
    z.object({
      message: z.string().min(1),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    return c.json({ echoed: body.message });
  },
);

app.get("*", async (c) => {
  const assets = (c.env as { ASSETS?: Fetcher }).ASSETS;
  if (assets) return assets.fetch(c.req.raw);
  return c.text("Static assets binding not configured.", 404);
});

export default app;
`,
			"src/main.tsx": `import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { queryClient } from "./query-client";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
`,
			"src/query-client.ts": `import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient();
`,
			"src/App.tsx": `import { useQuery } from "@tanstack/react-query";

async function fetchHealth() {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error("Health check failed");
  return (await response.json()) as { ok: boolean; app: string; timestamp: string };
}

export function App() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });

  return (
    <main className="container">
      <h1>__PROJECT_NAME__</h1>
      <p>Cloudflare full-stack scaffold loaded.</p>
      {isLoading && <p>Checking API health...</p>}
      {error && <p className="error">{String(error)}</p>}
      {data && (
        <pre>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </main>
  );
}
`,
			"src/styles.css": `:root {
  color-scheme: light;
  font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
}

body {
  margin: 0;
  background: linear-gradient(180deg, #f8fafc, #eef2ff);
  color: #111827;
}

.container {
  max-width: 840px;
  margin: 0 auto;
  padding: 3rem 1rem;
}

.error {
  color: #b91c1c;
}
`,
			"src/lib/utils.ts": `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`,
			"src/components/ui/button.tsx": `import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium",
        "bg-black text-white hover:opacity-90 transition-opacity",
        className,
      )}
      {...props}
    />
  );
}
`,
			"components.json": `{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils"
  }
}
`,
		},
	},
	api: {
		templateType: "api",
		source: {
			repository: "https://github.com/cloudflare/workers-sdk",
			templatePath: "packages/create-cloudflare/templates/hono/workers + netm8 overlay",
			generatedAt: "2026-02-28",
		},
		files: {
			"package.json": `{
  "name": "__PROJECT_NAME__",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "cf-typegen": "wrangler types"
  },
  "dependencies": {
    "@hono/zod-validator": "^0.7.6",
    "hono": "^4.12.3",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^25.3.2",
    "typescript": "^5.9.3",
    "wrangler": "^4.69.0"
  }
}`,
			"README.md": `# __PROJECT_NAME__

Cloudflare Workers API scaffold with Hono + Zod.

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`
`,
			"tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["./worker-configuration.d.ts"]
  },
  "include": ["src"]
}
`,
			"wrangler.jsonc": `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "__PROJECT_NAME__",
  "main": "src/index.ts",
  "compatibility_date": "2026-02-28",
  "compatibility_flags": ["nodejs_compat"]
}
`,
			"src/index.ts": `import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono();

app.get("/health", (c) => {
  return c.json({
    ok: true,
    app: "__PROJECT_NAME__",
    timestamp: new Date().toISOString(),
  });
});

app.post(
  "/echo",
  zValidator(
    "json",
    z.object({
      message: z.string().min(1),
    }),
  ),
  async (c) => {
    const body = c.req.valid("json");
    return c.json({ echoed: body.message });
  },
);

export default app;
`,
		},
	},
};

async function readScaffoldBundleFromR2(
	storage: R2Bucket | undefined,
	templateType: ScaffoldTemplateType,
): Promise<ScaffoldBundle | null> {
	if (!storage) return null;
	const object = await storage.get(`scaffolds/${templateType}.json`);
	if (!object) return null;

	const payload = await object.text();
	const parsed = JSON.parse(payload) as Partial<ScaffoldBundle>;
	if (!parsed || typeof parsed !== "object" || typeof parsed.files !== "object") {
		throw new Error(`Invalid scaffold object for template ${templateType}.`);
	}

	return {
		templateType,
		source: parsed.source,
		files: parsed.files as Record<string, string>,
	};
}

async function loadScaffoldFiles(
	storage: R2Bucket | undefined,
	templateType: ScaffoldTemplateType,
	projectName: string,
): Promise<Record<string, string>> {
	const normalizedName = normalizeProjectName(projectName);
	const bundle =
		(await readScaffoldBundleFromR2(storage, templateType)) ?? FALLBACK_SCAFFOLDS[templateType];
	return mapTemplateFiles(bundle.files, normalizedName);
}

// ── System Prompts ──────────────────────────────────────────────────────

export function buildSystemPrompt(mode: RunProjectStreamMode, feedback?: string): string {
	const toolCatalog = buildToolCatalogJson();
	const modeBlock =
		mode === "feedback"
			? `This is an existing project — the user's files are already in /workspace/.
Apply requested changes only. Do NOT rebuild from scratch.
User feedback: ${feedback ?? "No feedback provided."}`
			: "Build from an empty /workspace/ directory.";
	const workflowBlock =
		mode === "feedback"
			? `Execution workflow requirements:
1. The project scaffold is already present in /workspace/. Do NOT call fetch_scaffold.
2. Implement requested changes with write_file/edit_file.
3. Use edit_file(fileName, existingCode, replacementCode) for targeted patch updates.
4. Run exec(command="npm test"/"npm run build"/verification) and fix errors.
5. Call done(summary=...) after edits and verification pass.`
			: `Execution workflow requirements:
1. First tool call MUST be fetch_scaffold(projectName="...", templateType="fullstack|api").
2. Scaffold selection rule: use templateType="api" for API-first specs; otherwise use "fullstack".
3. After scaffold load, implement requested features by write_file/edit_file operations.
4. Use edit_file(fileName, existingCode, replacementCode) for targeted patch updates.
5. Run exec(command="npm install") only after scaffold files exist.
6. Run exec(command="npm test"/"npm run build"/verification) and fix errors.
7. Call done(summary=...) only after scaffold load, custom code edits, and verification.
8. done(), write_file(), edit_file(), and exec() will fail before fetch_scaffold().`;

	return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>

You are an expert in composing functions for code generation in a Linux sandbox (Node.js 20 + npm).
You are given a project spec and a set of possible functions/tools.
Based on the project spec, make one or more function/tool calls to complete the software build.
If a required parameter is missing for a function call, point it out and request the missing value.
If none of the functions can be used, point it out.

You should only return function call content in tool-call responses.
If you decide to invoke function(s), you MUST use this format exactly:
[func_name1(param_name1=param_value1, param_name2=param_value2), func_name2(...)]
You SHOULD NOT include any other text in tool-call responses.

Here is the list of functions in JSON format that you can invoke.
${toolCatalog}

${workflowBlock}

General constraints:
- Call exactly one tool per response.
- Implement every requested feature with production-ready code.
- Paths are relative to /workspace/ (e.g. src/index.ts).
- ${modeBlock}
<|eot_id|><|start_header_id|>assistant<|end_header_id|>`;
}

export const BUILD_SYSTEM_PROMPT = buildSystemPrompt("initial");

export function specToPrompt(spec: SpecResult): string {
	return `Build this project:
Name: ${spec.name}
Description: ${spec.description}
Platform: ${spec.platform}
Features: ${spec.features.join(", ")}`;
}

// ── Sandbox tools (streaming) ───────────────────────────────────────────

function createStreamingTools({
	sandbox,
	files,
	onFileWrite,
	storage,
}: {
	sandbox: ReturnType<typeof getSandbox>;
	files: Map<string, string>;
	onFileWrite: (path: string, content: string) => void;
	storage?: R2Bucket;
}) {
	let scaffoldLoaded = files.size > 0;
	let hasCustomEdits = files.size > 0;

	const assertScaffoldLoaded = () => {
		if (!scaffoldLoaded) {
			throw new Error(
				"Scaffold not loaded. Call fetch_scaffold(projectName, templateType) before coding tools.",
			);
		}
	};

	return {
		fetch_scaffold: tool({
			description: TOOL_DESCRIPTIONS.fetch_scaffold,
			inputSchema: TOOL_INPUT_SCHEMAS.fetch_scaffold,
			execute: async ({ projectName, templateType }: BuildToolArgs<"fetch_scaffold">) => {
				if (scaffoldLoaded) {
					throw new Error(
						"Scaffold already loaded for this session. Continue with write_file/edit_file.",
					);
				}
				console.log(`[tool:fetch_scaffold] Loading ${templateType} scaffold for ${projectName}`);
				const scaffoldFiles = await loadScaffoldFiles(storage, templateType, projectName);
				const entries = Object.entries(scaffoldFiles);
				for (const [path, content] of entries) {
					await sandbox.writeFile(`/workspace/${path}`, content);
					files.set(path, content);
					onFileWrite(path, content);
				}
				scaffoldLoaded = true;
				hasCustomEdits = false;
				console.log(`[tool:fetch_scaffold] Loaded ${entries.length} files`);
				return `Scaffold loaded: ${templateType} (${entries.length} files)`;
			},
		}),

		write_file: tool({
			description: TOOL_DESCRIPTIONS.write_file,
			inputSchema: TOOL_INPUT_SCHEMAS.write_file,
			execute: async ({ fileName, fileType, fileBody }: BuildToolArgs<"write_file">) => {
				assertScaffoldLoaded();
				console.log(
					`[tool:write_file] Starting: ${fileName} [${fileType}] (${fileBody.length} bytes)`,
				);
				try {
					await sandbox.writeFile(`/workspace/${fileName}`, fileBody);
				} catch (err) {
					console.error("[tool:write_file] FAILED:", err instanceof Error ? err.message : err);
					throw err;
				}
				files.set(fileName, fileBody);
				onFileWrite(fileName, fileBody);
				hasCustomEdits = true;
				console.log(`[tool:write_file] Done: ${fileName}`);
				return `Wrote ${fileName} (${fileBody.length} bytes)`;
			},
		}),

		read_file: tool({
			description: TOOL_DESCRIPTIONS.read_file,
			inputSchema: TOOL_INPUT_SCHEMAS.read_file,
			execute: async ({ fileName }: BuildToolArgs<"read_file">) => {
				assertScaffoldLoaded();
				console.log(`[tool:read_file] Reading: ${fileName}`);
				const file = await sandbox.readFile(`/workspace/${fileName}`);
				return file.content;
			},
		}),

		edit_file: tool({
			description: TOOL_DESCRIPTIONS.edit_file,
			inputSchema: TOOL_INPUT_SCHEMAS.edit_file,
			execute: async ({ fileName, existingCode, replacementCode }: BuildToolArgs<"edit_file">) => {
				assertScaffoldLoaded();
				console.log(`[tool:edit_file] Editing: ${fileName}`);
				let currentContent = files.get(fileName);
				if (currentContent === undefined) {
					try {
						const file = await sandbox.readFile(`/workspace/${fileName}`);
						currentContent = file.content;
					} catch (err) {
						const message =
							err instanceof Error ? err.message : "Unable to read file before edit operation.";
						throw new Error(`Cannot edit ${fileName}: ${message}`);
					}
				}

				if (!currentContent.includes(existingCode)) {
					throw new Error(
						`Cannot edit ${fileName}: existingCode snippet not found. Provide an exact existingCode reference.`,
					);
				}

				const updatedContent = currentContent.replace(existingCode, replacementCode);
				await sandbox.writeFile(`/workspace/${fileName}`, updatedContent);
				files.set(fileName, updatedContent);
				onFileWrite(fileName, updatedContent);
				hasCustomEdits = true;
				return `Edited ${fileName}`;
			},
		}),

		exec: tool({
			description: TOOL_DESCRIPTIONS.exec,
			inputSchema: TOOL_INPUT_SCHEMAS.exec,
			execute: async ({ command }: BuildToolArgs<"exec">) => {
				assertScaffoldLoaded();
				if (files.size === 0) {
					throw new Error(
						"Cannot run exec before writing files. Load scaffold first and then write/edit files.",
					);
				}
				console.log(`[tool:exec] Running: ${command}`);
				const result = await sandbox.exec(command, {
					cwd: "/workspace",
					timeout: 120_000,
				});
				const output = JSON.stringify({
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
					success: result.exitCode === 0,
				});
				console.log(`[tool:exec] Exit code: ${result.exitCode}, output: ${output.slice(0, 500)}`);
				return output;
			},
		}),

		done: tool({
			description: TOOL_DESCRIPTIONS.done,
			inputSchema: TOOL_INPUT_SCHEMAS.done,
			execute: async ({ summary }: BuildToolArgs<"done">) => {
				assertScaffoldLoaded();
				if (files.size === 0) {
					const message =
						"Cannot complete build before writing files. Use write_file to create project files first.";
					console.warn(`[tool:done] Rejected: ${message}`);
					throw new Error(message);
				}
				if (!hasCustomEdits) {
					throw new Error(
						"Cannot complete build directly after scaffold load. Use write_file or edit_file to implement requested features first.",
					);
				}
				if (!files.has("package.json")) {
					throw new Error(
						'Cannot complete build before creating package.json. Use write_file with fileName="package.json".',
					);
				}
				console.log("[tool:done] Build complete");
				return summary;
			},
		}),
	};
}

type StreamingToolSet = ReturnType<typeof createStreamingTools>;

export function stopWhenDoneWithFiles(files: Map<string, string>): StopCondition<StreamingToolSet> {
	return ({ steps }) => {
		if (files.size === 0 || steps.length === 0) return false;
		const lastStep = steps[steps.length - 1];
		return lastStep.toolResults.some((result) => result.toolName === "done");
	};
}

// ── Tool-call middleware ─────────────────────────────────────────────────
// Workers AI streaming does not reliably return structured tool_calls for
// Llama 3.3 — the model outputs function-call JSON as plain text instead.
// This middleware routes through doGenerate (non-streaming) where tool calls
// are more reliable, then falls back to parsing text-based function calls
// when the API still returns them as text.

type ParsedTextToolCall = {
	toolName: string;
	input: string;
	range: { start: number; end: number };
};

type MutableGeneratePart = {
	type: string;
	text?: string;
	[key: string]: unknown;
};

type MutableGenerateResult = {
	content?: MutableGeneratePart[];
	finishReason?: { unified?: string; [key: string]: unknown };
};

type ReasoningStepEvent = {
	toolCalls?: Array<{ toolName?: string; input?: unknown }>;
	content?: Array<{ type?: string; toolName?: string; error?: unknown }>;
};

function extractTopLevelJsonObjectSpans(
	text: string,
): Array<{ start: number; end: number; raw: string }> {
	const spans: Array<{ start: number; end: number; raw: string }> = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			if (depth === 0) {
				start = i;
			}
			depth++;
			continue;
		}

		if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				spans.push({
					start,
					end: i + 1,
					raw: text.slice(start, i + 1),
				});
				start = -1;
			}
		}
	}

	return spans;
}

function extractTopLevelSquareBracketSpans(
	text: string,
): Array<{ start: number; end: number; raw: string }> {
	const spans: Array<{ start: number; end: number; raw: string }> = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				inString = false;
				quote = null;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			continue;
		}

		if (ch === "[") {
			if (depth === 0) {
				start = i;
			}
			depth++;
			continue;
		}

		if (ch === "]" && depth > 0) {
			depth--;
			if (depth === 0 && start !== -1) {
				spans.push({
					start,
					end: i + 1,
					raw: text.slice(start, i + 1),
				});
				start = -1;
			}
		}
	}

	return spans;
}

function normalizeJsonObjectString(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return JSON.stringify({});

	const candidates = new Set<string>();
	const addCandidate = (candidate: string | null | undefined) => {
		if (!candidate) return;
		const normalized = candidate.trim();
		if (normalized) {
			candidates.add(normalized);
		}
	};

	addCandidate(trimmed);

	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	addCandidate(fenced?.[1]);

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		addCandidate(trimmed.slice(1, -1));
	}

	const singleQuoteJson = trimmed
		.replace(/([{,]\s*)'([^'\\]+)'\s*:/g, '$1"$2":')
		.replace(
			/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[,}])/g,
			(_match, value: string, trailing: string) =>
				`:${JSON.stringify(value.replace(/\\'/g, "'"))}${trailing}`,
		);
	addCandidate(singleQuoteJson);

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(parsed);
			}
		} catch {
			// Keep trying candidates.
		}
	}

	return null;
}

function serializeToolInput(rawInput: unknown): string {
	if (rawInput == null) return "{}";

	if (typeof rawInput === "string") {
		const normalized = normalizeJsonObjectString(rawInput);
		return normalized ?? rawInput.trim();
	}

	return JSON.stringify(rawInput);
}

function normalizeToolCallObject(obj: unknown): { toolName: string; input: string } | null {
	if (!obj || typeof obj !== "object") return null;

	const record = obj as Record<string, unknown>;
	const functionObj =
		record.function && typeof record.function === "object"
			? (record.function as Record<string, unknown>)
			: null;

	const toolNameCandidate =
		functionObj?.name ?? functionObj?.toolName ?? record.name ?? record.toolName ?? record.tool;
	if (typeof toolNameCandidate !== "string" || toolNameCandidate.trim() === "") return null;
	const normalizedToolName = toolNameCandidate.trim();
	if (!isBuildToolName(normalizedToolName)) return null;

	const rawArgs =
		functionObj?.parameters ??
		functionObj?.arguments ??
		functionObj?.input ??
		functionObj?.args ??
		record.parameters ??
		record.arguments ??
		record.input ??
		record.args ??
		{};

	return {
		toolName: normalizedToolName,
		input: serializeToolInput(rawArgs),
	};
}

function splitTopLevel(text: string, delimiter = ","): string[] {
	const parts: string[] = [];
	let start = 0;
	let paren = 0;
	let brace = 0;
	let bracket = 0;
	let inString = false;
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				inString = false;
				quote = null;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			continue;
		}

		if (ch === "(") paren++;
		else if (ch === ")" && paren > 0) paren--;
		else if (ch === "{") brace++;
		else if (ch === "}" && brace > 0) brace--;
		else if (ch === "[") bracket++;
		else if (ch === "]" && bracket > 0) bracket--;

		if (ch === delimiter && paren === 0 && brace === 0 && bracket === 0) {
			parts.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}

	const final = text.slice(start).trim();
	if (final) parts.push(final);
	return parts.filter(Boolean);
}

function findTopLevelEquals(text: string): number {
	let paren = 0;
	let brace = 0;
	let bracket = 0;
	let inString = false;
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === quote) {
				inString = false;
				quote = null;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			continue;
		}

		if (ch === "(") paren++;
		else if (ch === ")" && paren > 0) paren--;
		else if (ch === "{") brace++;
		else if (ch === "}" && brace > 0) brace--;
		else if (ch === "[") bracket++;
		else if (ch === "]" && bracket > 0) bracket--;
		else if (ch === "=" && paren === 0 && brace === 0 && bracket === 0) return i;
	}

	return -1;
}

function parseBracketValue(rawValue: string): unknown {
	const value = rawValue.trim();
	if (!value) return "";

	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		const unquoted = value.slice(1, -1);
		if (value.startsWith('"')) {
			try {
				return JSON.parse(value);
			} catch {
				return unquoted;
			}
		}
		return unquoted.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
	}

	if (/^-?\d+(?:\.\d+)?$/.test(value)) {
		return Number(value);
	}

	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;

	if (
		(value.startsWith("{") && value.endsWith("}")) ||
		(value.startsWith("[") && value.endsWith("]"))
	) {
		const normalized = normalizeJsonObjectString(value) ?? value;
		try {
			return JSON.parse(normalized);
		} catch {
			return value;
		}
	}

	return value;
}

function parseBracketArguments(argsText: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const args = splitTopLevel(argsText, ",");
	for (const arg of args) {
		const eq = findTopLevelEquals(arg);
		if (eq <= 0) continue;
		const key = arg.slice(0, eq).trim();
		if (!key) continue;
		const rawValue = arg.slice(eq + 1).trim();
		out[key] = parseBracketValue(rawValue);
	}
	return out;
}

function parseBracketToolCalls(text: string): ParsedTextToolCall[] | null {
	const calls: ParsedTextToolCall[] = [];
	const spans = extractTopLevelSquareBracketSpans(text);

	for (const span of spans) {
		const raw = span.raw.trim();
		if (!raw.startsWith("[") || !raw.endsWith("]")) continue;
		const inner = raw.slice(1, -1).trim();
		if (!inner || !inner.includes("(")) continue;

		const segments = splitTopLevel(inner, ",");
		for (const segment of segments) {
			const match = segment.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/);
			if (!match) continue;

			const toolName = match[1].trim();
			if (!isBuildToolName(toolName)) continue;

			const argsText = match[2]?.trim() ?? "";
			const args = argsText ? parseBracketArguments(argsText) : {};
			calls.push({
				toolName,
				input: serializeToolInput(args),
				range: { start: span.start, end: span.end },
			});
		}
	}

	return calls.length > 0 ? calls : null;
}

export function parseTextToolCalls(text: string): ParsedTextToolCall[] | null {
	const calls: ParsedTextToolCall[] = [];
	const spans = extractTopLevelJsonObjectSpans(text);

	for (const span of spans) {
		try {
			const parsed = JSON.parse(span.raw);
			const call = normalizeToolCallObject(parsed);
			if (call) {
				calls.push({
					...call,
					range: { start: span.start, end: span.end },
				});
			}
		} catch {
			// Ignore non-JSON object spans.
		}
	}

	const bracketCalls = parseBracketToolCalls(text);
	if (bracketCalls) {
		calls.push(...bracketCalls);
	}

	return calls.length > 0 ? calls : null;
}

function stripMatchedToolCallText(text: string, calls: ParsedTextToolCall[]): string {
	if (calls.length === 0) return text;

	const uniqueByRange = [
		...new Map(calls.map((call) => [`${call.range.start}:${call.range.end}`, call])).values(),
	];
	const sorted = uniqueByRange.sort((a, b) => b.range.start - a.range.start);
	let out = text;
	for (const call of sorted) {
		out = out.slice(0, call.range.start) + out.slice(call.range.end);
	}
	return out.trim();
}

function recoverToolCallsFromTextParts(content: MutableGeneratePart[]): {
	content: MutableGeneratePart[];
	recoveredToolCalls: number;
} {
	const next: MutableGeneratePart[] = [];
	let recoveredToolCalls = 0;

	for (const part of content) {
		if (part.type !== "text" || typeof part.text !== "string") {
			next.push(part);
			continue;
		}

		const parsed = parseTextToolCalls(part.text);
		if (!parsed) {
			next.push(part);
			continue;
		}

		const cleanText = stripMatchedToolCallText(part.text, parsed);
		if (cleanText) {
			next.push({ ...part, text: cleanText });
		}

		for (const call of parsed) {
			next.push({
				type: "tool-call",
				toolCallId: `tc_${crypto.randomUUID().slice(0, 8)}`,
				toolName: call.toolName,
				input: call.input,
			});
			recoveredToolCalls++;
		}
	}

	return { content: next, recoveredToolCalls };
}

export function normalizeResultToolCalls(result: MutableGenerateResult): {
	recoveredToolCalls: number;
	toolCallCount: number;
} {
	const hasStructuredToolCalls = result.content?.some((part) => part.type === "tool-call") ?? false;
	let recoveredToolCalls = 0;

	if (!hasStructuredToolCalls && result.content) {
		const recovered = recoverToolCallsFromTextParts(result.content);
		result.content = recovered.content;
		recoveredToolCalls = recovered.recoveredToolCalls;
	}

	const toolCallCount = result.content?.filter((part) => part.type === "tool-call").length ?? 0;
	if (toolCallCount > 0 && result.content) {
		// Drop all free-form model text for tool-call turns.
		// This prevents internal planning/tool-call boilerplate from leaking to the client chat UI.
		result.content = result.content.filter((part) => part.type !== "text");
	}
	if (toolCallCount > 0 && result.finishReason?.unified === "stop") {
		result.finishReason = { ...result.finishReason, unified: "tool-calls" };
	}

	return { recoveredToolCalls, toolCallCount };
}

function parseToolInput(input: unknown): Record<string, unknown> {
	if (typeof input === "string") {
		try {
			const parsed = JSON.parse(input) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return input && typeof input === "object" && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function summarizeStepForReasoning(event: ReasoningStepEvent): string | null {
	const toolError = event.content?.find((part) => part.type === "tool-error");
	if (toolError) {
		const toolName = toolError.toolName ?? "tool";
		const reason = toErrorMessage(toolError.error);
		return `Fixing ${toolName} error: ${reason.slice(0, 120)}`;
	}

	const call = event.toolCalls?.[0];
	if (!call?.toolName) return null;
	const input = parseToolInput(call.input);

	if (call.toolName === "write_file") {
		const fileName =
			typeof input.fileName === "string" && input.fileName.trim().length > 0
				? input.fileName.trim()
				: "";
		return fileName ? `Writing ${fileName}` : "Writing project files";
	}

	if (call.toolName === "fetch_scaffold") {
		const templateType =
			typeof input.templateType === "string" && input.templateType.trim().length > 0
				? input.templateType.trim()
				: "template";
		const projectName =
			typeof input.projectName === "string" && input.projectName.trim().length > 0
				? input.projectName.trim()
				: "project";
		return `Loading ${templateType} scaffold for ${projectName}`;
	}

	if (call.toolName === "edit_file") {
		const fileName =
			typeof input.fileName === "string" && input.fileName.trim().length > 0
				? input.fileName.trim()
				: "";
		return fileName ? `Editing ${fileName}` : "Editing existing files";
	}

	if (call.toolName === "read_file") {
		const fileName =
			typeof input.fileName === "string" && input.fileName.trim().length > 0
				? input.fileName.trim()
				: "";
		return fileName ? `Reading ${fileName}` : "Reading project files";
	}

	if (call.toolName === "exec") {
		const command =
			typeof input.command === "string" && input.command.trim().length > 0
				? input.command.trim()
				: "";
		return command ? `Running ${command.slice(0, 100)}` : "Running validation commands";
	}

	if (call.toolName === "done") {
		return "Finalizing build output";
	}

	return null;
}

function repairToolCallInput(rawInput: string): string | null {
	const normalized = normalizeJsonObjectString(rawInput);
	if (!normalized) return null;

	try {
		const parsed = JSON.parse(normalized) as Record<string, unknown>;
		const functionObj =
			parsed.function && typeof parsed.function === "object"
				? (parsed.function as Record<string, unknown>)
				: null;

		const nestedInput =
			functionObj?.parameters ??
			functionObj?.arguments ??
			functionObj?.input ??
			functionObj?.args ??
			parsed.parameters ??
			parsed.arguments ??
			parsed.input ??
			parsed.args;

		if (nestedInput !== undefined) {
			return serializeToolInput(nestedInput);
		}

		return JSON.stringify(parsed);
	} catch {
		return normalized;
	}
}

export const repairMalformedToolCall: ToolCallRepairFunction<StreamingToolSet> = async ({
	toolCall,
}) => {
	const repairedInput = repairToolCallInput(toolCall.input);
	if (repairedInput) {
		return { ...toolCall, input: repairedInput };
	}

	const parsedTextCalls = parseTextToolCalls(toolCall.input);
	if (!parsedTextCalls || parsedTextCalls.length === 0) return null;

	const matchedCall =
		parsedTextCalls.find((call) => call.toolName === toolCall.toolName) ?? parsedTextCalls[0];

	return {
		...toolCall,
		toolName: matchedCall.toolName,
		input: matchedCall.input,
	};
};

function toolCallMiddleware(kv?: KVNamespace): LanguageModelMiddleware {
	return {
		specificationVersion: "v3",

		// Non-streaming: check for text-based tool calls if no structured ones
		wrapGenerate: async ({ doGenerate }) => {
			const result = await doGenerate();
			normalizeResultToolCalls(result as MutableGenerateResult);

			return result;
		},

		// Streaming: delegate to doGenerate for reliable tool-call detection,
		// then simulate a stream from the result.
		wrapStream: async ({ doGenerate, params }) => {
			// Log input messages to verify tool results flow back
			const inputMessages = (params as { prompt?: unknown[] }).prompt ?? [];
			const messageSummary = (inputMessages as { role: string; content: unknown }[]).map((m) => {
				if (m.role === "tool") {
					const parts = Array.isArray(m.content) ? m.content : [];
					return `tool(${parts.length} results)`;
				}
				if (m.role === "assistant") {
					const parts = Array.isArray(m.content) ? m.content : [];
					const types = parts.map((p: { type: string }) => p.type);
					return `assistant[${types.join(",")}]`;
				}
				return m.role;
			});
			console.log(`[middleware:wrapStream] input: ${messageSummary.join(" → ")}`);

			const result = await doGenerate();

			// Diagnostic logging
			const contentTypes = result.content?.map((p: { type: string }) => p.type) ?? [];
			const toolCallParts =
				result.content?.filter((p: { type: string }) => p.type === "tool-call") ?? [];

			const logEntry = {
				timestamp: new Date().toISOString(),
				phase: "after-doGenerate",
				inputMessageCount: inputMessages.length,
				inputMessageRoles: messageSummary,
				contentTypes,
				finishReason: result.finishReason,
				toolCallCount: toolCallParts.length,
				toolCallNames: toolCallParts.map((p: unknown) => (p as { toolName?: string }).toolName),
				rawContent: JSON.stringify(result.content).slice(0, 2000),
			};
			console.log("[middleware:wrapStream]", JSON.stringify(logEntry));
			if (kv) {
				try {
					const prev = await kv.get("debug:middleware-log");
					const logs = prev ? JSON.parse(prev) : [];
					logs.push(logEntry);
					await kv.put("debug:middleware-log", JSON.stringify(logs.slice(-10)), {
						expirationTtl: 300,
					});
				} catch {
					// Best-effort
				}
			}

			const recovery = normalizeResultToolCalls(result as MutableGenerateResult);

			// Log final content after extraction
			const finalTypes = result.content?.map((p: { type: string }) => p.type) ?? [];
			const toolCalls =
				result.content?.filter((p: { type: string }) => p.type === "tool-call") ?? [];
			console.log(
				`[middleware:wrapStream] after extraction: [${finalTypes.join(", ")}], tool calls: ${toolCalls.length}, recovered=${recovery.recoveredToolCalls}, finishReason: ${result.finishReason?.unified}`,
			);

			// Simulate a stream from the generate result.
			// Keep tool-call parts in V3 format ({ input }) so streamText can parse
			// and execute tools in the multi-step loop.
			const simulatedStream = createSimulatedStreamFromGenerateResult(result);

			return {
				stream: simulatedStream,
				request: result.request,
				response: result.response,
			};
		},
	};
}

type SimulatedGenerateResult = {
	warnings: unknown[];
	response?: unknown;
	content: Array<{ type: string; [key: string]: unknown }>;
	finishReason: unknown;
	usage: unknown;
	providerMetadata?: unknown;
};

export function createSimulatedStreamFromGenerateResult(result: SimulatedGenerateResult) {
	let id = 0;
	return new ReadableStream({
		start(controller) {
			controller.enqueue({ type: "stream-start", warnings: result.warnings });
			if (result.response && typeof result.response === "object") {
				controller.enqueue({
					type: "response-metadata",
					...(result.response as Record<string, unknown>),
				});
			}

			for (const part of result.content) {
				switch (part.type) {
					case "text": {
						const text = typeof part.text === "string" ? part.text : "";
						if (text.length > 0) {
							controller.enqueue({ type: "text-start", id: String(id) });
							controller.enqueue({
								type: "text-delta",
								id: String(id),
								delta: text,
							});
							controller.enqueue({ type: "text-end", id: String(id) });
							id++;
						}
						break;
					}
					default: {
						controller.enqueue(part);
						break;
					}
				}
			}

			controller.enqueue({
				type: "finish",
				finishReason: result.finishReason,
				usage: result.usage,
				providerMetadata: result.providerMetadata,
			});
			controller.close();
		},
	});
}

function createModel(env: { AI: Ai; CACHE?: KVNamespace }) {
	const workersai = createWorkersAI({ binding: env.AI });
	return wrapLanguageModel({
		model: workersai(MODEL),
		middleware: toolCallMiddleware(env.CACHE),
	});
}

// ── Streaming build functions ───────────────────────────────────────────

export function runProjectStream({
	env,
	spec,
	sandbox,
	files,
	onFileWrite,
	onFinish,
	onReasoningUpdate,
	mode,
	feedback,
}: {
	env: { AI: Ai; CACHE?: KVNamespace; STORAGE?: R2Bucket };
	spec: SpecResult;
	sandbox: ReturnType<typeof getSandbox>;
	files: Map<string, string>;
	onFileWrite: (path: string, content: string) => void;
	onFinish?: StreamTextOnFinishCallback<ToolSet>;
	onReasoningUpdate?: (text: string) => void;
	mode: RunProjectStreamMode;
	feedback?: string;
}) {
	const model = createModel(env);
	const tools = createStreamingTools({
		sandbox,
		files,
		onFileWrite,
		storage: env.STORAGE,
	});
	const systemPrompt = buildSystemPrompt(mode, feedback);

	if (mode === "initial") {
		console.log("[runProjectStream] Starting build for:", spec.name);
	}

	return streamText({
		model,
		system: systemPrompt,
		messages: [{ role: "user", content: specToPrompt(spec) }],
		tools,
		toolChoice: "auto",
		maxOutputTokens: 4096,
		stopWhen: [stopWhenDoneWithFiles(files), stepCountIs(MAX_STEPS)],
		experimental_repairToolCall: repairMalformedToolCall,
		onStepFinish: (event) => {
			if (mode === "initial") {
				console.log(
					`[runProjectStream] Step finished: finishReason=${event.finishReason}, toolCalls=${event.toolCalls?.length ?? 0}, text=${event.text?.slice(0, 200) ?? "(none)"}`,
				);
			}
			const reasoningStep = summarizeStepForReasoning(event as ReasoningStepEvent);
			if (reasoningStep) {
				onReasoningUpdate?.(reasoningStep);
			}
		},
		onFinish: onFinish
			? (event) => onFinish(event as unknown as Parameters<StreamTextOnFinishCallback<ToolSet>>[0])
			: undefined,
	});
}

// ── Sandbox lifecycle helpers ───────────────────────────────────────────

export function createSandbox(env: { Sandbox: DurableObjectNamespace<Sandbox> }) {
	const sandboxId = crypto.randomUUID().slice(0, 8);
	return getSandbox(env.Sandbox, `spawn-${sandboxId}`);
}

export async function seedSandbox(
	sandbox: ReturnType<typeof getSandbox>,
	existingFiles: Map<string, string>,
) {
	for (const [path, content] of existingFiles) {
		await sandbox.writeFile(`/workspace/${path}`, content);
	}
}
