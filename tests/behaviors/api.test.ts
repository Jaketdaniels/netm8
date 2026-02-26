import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("API", () => {
  describe("given a request to /api/", () => {
    it("responds with JSON containing the app name", async () => {
      const response = await SELF.fetch("https://example.com/api/");
      const data = (await response.json()) as { name: string };

      expect(response.status).toBe(200);
      expect(data).toHaveProperty("name");
    });
  });

  describe("given a request to an unknown API route", () => {
    it("responds with 404", async () => {
      const response = await SELF.fetch("https://example.com/api/nonexistent");
      expect(response.status).toBe(404);
    });
  });
});
