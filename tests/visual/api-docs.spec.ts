import { expect, test } from "@playwright/test";

test.describe("API Docs page", () => {
	test("matches screenshot", async ({ page }) => {
		await page.goto("/api-docs");
		await page.waitForLoadState("networkidle");
		await expect(page).toHaveScreenshot("api-docs.png", { fullPage: true });
	});
});
