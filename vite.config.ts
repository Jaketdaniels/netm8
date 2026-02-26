import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	resolve: {
		alias: {
			"@": resolve(import.meta.dirname, "./src"),
		},
	},
	plugins: [
		tailwindcss(),
		TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
		react(),
		cloudflare({ configPath: "./wrangler.jsonc" }),
	],
});
