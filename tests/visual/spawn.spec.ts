import { expect, test } from "@playwright/test";

test.describe("Spawn page", () => {
	test("matches screenshot", async ({ page }) => {
		await page.goto("/spawn");
		await page.waitForLoadState("networkidle");
		await expect(page).toHaveScreenshot("spawn.png", { fullPage: true });
	});
});
