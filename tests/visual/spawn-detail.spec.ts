import { expect, test } from "@playwright/test";

test.describe("Spawn detail page", () => {
	test("matches screenshot", async ({ page }) => {
		await page.goto("/spawn/test-id");
		await page.waitForLoadState("networkidle");
		await expect(page).toHaveScreenshot("spawn-detail.png", { fullPage: true });
	});
});
