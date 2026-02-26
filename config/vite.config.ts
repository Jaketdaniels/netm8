import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));

export default defineConfig({
	root,
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	resolve: {
		alias: {
			"@": resolve(root, "src"),
		},
	},
	plugins: [
		tailwindcss(),
		TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
		react(),
		cloudflare({ configPath: resolve(root, "wrangler.jsonc") }),
	],
});
