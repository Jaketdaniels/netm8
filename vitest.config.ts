import { readFileSync } from "node:fs";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineWorkersConfig({
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
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					assets: { directory: "./dist/client", binding: "ASSETS" },
				},
			},
		},
	},
});
