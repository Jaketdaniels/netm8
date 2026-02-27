import { expect, test } from "@playwright/test";

test.describe("Home page", () => {
	test("matches screenshot", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await expect(page).toHaveScreenshot("home.png", { fullPage: true });
	});
});
