import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("API", () => {
	describe("given a request to /api/health", () => {
		it("responds with JSON containing the app name and version", async () => {
			const response = await SELF.fetch("https://example.com/api/health");
			const data = (await response.json()) as { name: string; version: string };

			expect(response.status).toBe(200);
			expect(data).toHaveProperty("name", "netm8");
			expect(data).toHaveProperty("version");
			expect(typeof data.version).toBe("string");
			expect(data.version.length).toBeGreaterThan(0);
		});
	});

	describe("given a request to an unknown API route", () => {
		it("responds with 404", async () => {
			const response = await SELF.fetch("https://example.com/api/nonexistent");
			expect(response.status).toBe(404);
		});
	});

	describe("given a request to /api/users", () => {
		it("responds with an array", async () => {
			const response = await SELF.fetch("https://example.com/api/users");
			const data = (await response.json()) as unknown[];

			expect(response.status).toBe(200);
			expect(Array.isArray(data)).toBe(true);
		});
	});
});
