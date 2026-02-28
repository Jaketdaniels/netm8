#!/usr/bin/env node

import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();
const OUTPUT_DIR = join(REPO_ROOT, "scaffolds");
const WORKERS_SDK_REPO = "https://github.com/cloudflare/workers-sdk";
const BUCKET_NAME = "netm8-assets";

const uploadEnabled = !process.argv.includes("--no-upload");

async function readDirectoryAsFileMap(rootDir) {
	const out = {};

	async function walk(currentDir) {
		const entries = await readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const abs = join(currentDir, entry.name);
			if (entry.isDirectory()) {
				await walk(abs);
				continue;
			}
			const rel = relative(rootDir, abs).replaceAll("\\", "/");
			out[rel] = await readFile(abs, "utf8");
		}
	}

	await walk(rootDir);
	return out;
}

function createOverlayFiles() {
	return {
		fullstack: {
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

Cloudflare Workers + Vite full-stack starter scaffold with React, Hono, Zod, Better Auth, TanStack Query, and shadcn/ui-compatible utilities.
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

app.get("/api/health", (c) => c.json({ ok: true, app: "__PROJECT_NAME__", timestamp: new Date().toISOString() }));

app.post("/api/echo", zValidator("json", z.object({ message: z.string().min(1) })), async (c) => {
  const body = c.req.valid("json");
  return c.json({ echoed: body.message });
});

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
  return response.json() as Promise<{ ok: boolean; app: string; timestamp: string }>;
}

export function App() {
  const { data, isLoading, error } = useQuery({ queryKey: ["health"], queryFn: fetchHealth });
  return (
    <main className="container">
      <h1>__PROJECT_NAME__</h1>
      <p>Cloudflare full-stack scaffold loaded.</p>
      {isLoading && <p>Checking API health...</p>}
      {error && <p className="error">{String(error)}</p>}
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
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
		},
		api: {
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

app.post("/echo", zValidator("json", z.object({ message: z.string().min(1) })), async (c) => {
  const body = c.req.valid("json");
  return c.json({ echoed: body.message });
});

export default app;
`,
		},
	};
}

async function main() {
	const tempDir = await mkdtemp(join(tmpdir(), "netm8-workers-sdk-"));
	try {
		console.log(`[scaffold] Cloning workers-sdk into ${tempDir}`);
		execSync(`git clone --depth 1 ${WORKERS_SDK_REPO} "${tempDir}"`, {
			stdio: "inherit",
		});

		const reactTemplateDir = join(tempDir, "packages/create-cloudflare/templates/react/workers/ts");
		const honoTemplateDir = join(
			tempDir,
			"packages/create-cloudflare/templates/hono/workers/templates",
		);
		const overlays = createOverlayFiles();

		const reactBaseFiles = await readDirectoryAsFileMap(reactTemplateDir);
		const honoBaseFiles = await readDirectoryAsFileMap(honoTemplateDir);

		const fullstackBundle = {
			templateType: "fullstack",
			source: {
				repository: WORKERS_SDK_REPO,
				templatePath: "packages/create-cloudflare/templates/react/workers/ts + netm8 overlay",
				generatedAt: new Date().toISOString(),
			},
			files: {
				...reactBaseFiles,
				...overlays.fullstack,
			},
		};

		const apiBundle = {
			templateType: "api",
			source: {
				repository: WORKERS_SDK_REPO,
				templatePath: "packages/create-cloudflare/templates/hono/workers/templates + netm8 overlay",
				generatedAt: new Date().toISOString(),
			},
			files: {
				...honoBaseFiles,
				...overlays.api,
			},
		};

		await mkdir(OUTPUT_DIR, { recursive: true });
		const fullstackPath = join(OUTPUT_DIR, "fullstack.json");
		const apiPath = join(OUTPUT_DIR, "api.json");
		await writeFile(fullstackPath, `${JSON.stringify(fullstackBundle, null, 2)}\n`, "utf8");
		await writeFile(apiPath, `${JSON.stringify(apiBundle, null, 2)}\n`, "utf8");
		console.log(`[scaffold] Wrote ${relative(REPO_ROOT, fullstackPath)}`);
		console.log(`[scaffold] Wrote ${relative(REPO_ROOT, apiPath)}`);

		if (uploadEnabled) {
			console.log(`[scaffold] Uploading bundles to R2 bucket ${BUCKET_NAME}`);
			execSync(
				`npx wrangler r2 object put ${BUCKET_NAME}/scaffolds/fullstack.json --file "${fullstackPath}" --remote`,
				{ stdio: "inherit", cwd: REPO_ROOT },
			);
			execSync(
				`npx wrangler r2 object put ${BUCKET_NAME}/scaffolds/api.json --file "${apiPath}" --remote`,
				{ stdio: "inherit", cwd: REPO_ROOT },
			);
		} else {
			console.log("[scaffold] Skipping R2 upload (--no-upload)");
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error("[scaffold] Failed:", error);
	process.exitCode = 1;
});
