import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Spawn API", () => {
	describe("given a request to list spawns", () => {
		it("responds with an array", async () => {
			const response = await SELF.fetch("https://example.com/api/spawns");
			const data = (await response.json()) as unknown[];

			expect(response.status).toBe(200);
			expect(Array.isArray(data)).toBe(true);
		});
	});

	describe("given a request to a non-existent spawn", () => {
		it("responds with 404", async () => {
			const response = await SELF.fetch("https://example.com/api/spawns/nonexistent");
			expect(response.status).toBe(404);
		});
	});

	describe("given a request to list files for a non-existent spawn", () => {
		it("responds with an empty array", async () => {
			const response = await SELF.fetch("https://example.com/api/spawns/nonexistent/files");
			const data = (await response.json()) as unknown[];

			expect(response.status).toBe(200);
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBe(0);
		});
	});
});
