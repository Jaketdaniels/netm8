import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "../tests/visual",
	snapshotDir: "../tests/visual/snapshots",
	outputDir: "../tests/visual/results",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: "html",
	use: {
		baseURL: "https://netm8-staging.jaketdaniels95.workers.dev",
		screenshot: "only-on-failure",
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
