import { expect, test } from "@playwright/test";

test.describe("Profile page", () => {
	test("matches screenshot", async ({ page }) => {
		await page.goto("/profile");
		await page.waitForLoadState("networkidle");
		await expect(page).toHaveScreenshot("profile.png", { fullPage: true });
	});
});
