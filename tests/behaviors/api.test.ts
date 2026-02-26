import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("API", () => {
	describe("given a request to /api/health", () => {
		it("responds with healthy status and binding checks", async () => {
			const response = await SELF.fetch("https://example.com/api/health");
			const data = (await response.json()) as {
				name: string;
				version: string;
				status: string;
				checks: Record<string, string>;
			};

			expect(response.status).toBe(200);
			expect(data).toHaveProperty("name", "netm8");
			expect(data).toHaveProperty("version");
			expect(data).toHaveProperty("status", "healthy");
			expect(data.checks.d1).toBe("ok");
			expect(data.checks.kv).toBe("ok");
			expect(data.checks.r2).toBe("ok");
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
