import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));

export default defineWorkersConfig({
	root,
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	test: {
		globals: true,
		setupFiles: ["./tests/setup.ts"],
		deps: {
			optimizer: {
				ssr: {
					include: ["ajv", "ajv-formats"],
				},
			},
		},
		poolOptions: {
			workers: {
				wrangler: { configPath: resolve(root, "wrangler.jsonc") },
				miniflare: {
					assets: { directory: resolve(root, "dist/client"), binding: "ASSETS" },
				},
			},
		},
	},
});
