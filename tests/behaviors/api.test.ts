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

	describe("given a POST request to /api/users", () => {
		it("creates a user with email and name", async () => {
			const response = await SELF.fetch("https://example.com/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "test@example.com", name: "Test User" }),
			});
			const data = (await response.json()) as {
				id: string;
				email: string;
				name: string;
				createdAt: string;
			};

			expect(response.status).toBe(201);
			expect(data.email).toBe("test@example.com");
			expect(data.name).toBe("Test User");
			expect(data.id).toBeDefined();
			expect(data.createdAt).toBeDefined();
		});

		it("creates a user with email only", async () => {
			const response = await SELF.fetch("https://example.com/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "minimal@example.com" }),
			});
			const data = (await response.json()) as { id: string; email: string; name: string | null };

			expect(response.status).toBe(201);
			expect(data.email).toBe("minimal@example.com");
			expect(data.name).toBeNull();
		});

		it("rejects invalid email", async () => {
			const response = await SELF.fetch("https://example.com/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "not-an-email" }),
			});

			expect(response.status).toBe(400);
		});

		it("rejects missing email", async () => {
			const response = await SELF.fetch("https://example.com/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "No Email" }),
			});

			expect(response.status).toBe(400);
		});
	});

	describe("given a GET request to /api/users/:id", () => {
		it("returns the user when found", async () => {
			const createRes = await SELF.fetch("https://example.com/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "findme@example.com", name: "Find Me" }),
			});
			const created = (await createRes.json()) as { id: string };

			const response = await SELF.fetch(`https://example.com/api/users/${created.id}`);
			const data = (await response.json()) as { id: string; email: string; name: string };

			expect(response.status).toBe(200);
			expect(data.id).toBe(created.id);
			expect(data.email).toBe("findme@example.com");
			expect(data.name).toBe("Find Me");
		});

		it("returns 404 for non-existent user", async () => {
			const response = await SELF.fetch(
				"https://example.com/api/users/00000000-0000-0000-0000-000000000000",
			);
			expect(response.status).toBe(404);
		});
	});

	describe("given a PUT request to /api/users/:id", () => {
		it("updates the user name", async () => {
			const createRes = await SELF.fetch("https://example.com/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "update@example.com", name: "Original" }),
			});
			const created = (await createRes.json()) as { id: string };

			const response = await SELF.fetch(`https://example.com/api/users/${created.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Updated" }),
			});
			const data = (await response.json()) as { id: string; name: string; updatedAt: string };

			expect(response.status).toBe(200);
			expect(data.name).toBe("Updated");
			expect(data.updatedAt).toBeDefined();
		});

		it("updates the user avatar URL", async () => {
			const createRes = await SELF.fetch("https://example.com/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "avatar@example.com" }),
			});
			const created = (await createRes.json()) as { id: string };

			const response = await SELF.fetch(`https://example.com/api/users/${created.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ avatarUrl: "https://example.com/avatar.png" }),
			});
			const data = (await response.json()) as { id: string; avatarUrl: string };

			expect(response.status).toBe(200);
			expect(data.avatarUrl).toBe("https://example.com/avatar.png");
		});

		it("returns 404 for non-existent user", async () => {
			const response = await SELF.fetch(
				"https://example.com/api/users/00000000-0000-0000-0000-000000000000",
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Ghost" }),
				},
			);
			expect(response.status).toBe(404);
		});

		it("rejects invalid avatar URL", async () => {
			const createRes = await SELF.fetch("https://example.com/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "badurl@example.com" }),
			});
			const created = (await createRes.json()) as { id: string };

			const response = await SELF.fetch(`https://example.com/api/users/${created.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ avatarUrl: "not-a-url" }),
			});

			expect(response.status).toBe(400);
		});
	});
});
