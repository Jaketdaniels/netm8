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

	describe("given a file upload to /api/uploads", () => {
		it("stores the file and returns metadata", async () => {
			const form = new FormData();
			form.append("file", new Blob(["hello world"], { type: "text/plain" }), "test.txt");

			const response = await SELF.fetch("https://example.com/api/uploads", {
				method: "POST",
				body: form,
			});
			const data = (await response.json()) as { url: string; filename: string; mediaType: string };

			expect(response.status).toBe(201);
			expect(data.filename).toBe("test.txt");
			expect(data.mediaType).toBe("text/plain");
			expect(data.url).toMatch(/^uploads\//);
		});

		it("rejects requests with no file", async () => {
			const form = new FormData();
			const response = await SELF.fetch("https://example.com/api/uploads", {
				method: "POST",
				body: form,
			});
			expect(response.status).toBe(400);
		});
	});

	describe("given a request to GET /api/uploads/:key", () => {
		it("returns the uploaded file content", async () => {
			const form = new FormData();
			form.append("file", new Blob(["file content"], { type: "text/plain" }), "read.txt");

			const uploadRes = await SELF.fetch("https://example.com/api/uploads", {
				method: "POST",
				body: form,
			});
			const { url } = (await uploadRes.json()) as { url: string };

			const response = await SELF.fetch(`https://example.com/api/uploads/${url}`);
			expect(response.status).toBe(200);

			const text = await response.text();
			expect(text).toBe("file content");
		});

		it("returns 404 for non-existent file", async () => {
			const response = await SELF.fetch("https://example.com/api/uploads/does/not/exist.txt");
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
