import { defineConfig } from "drizzle-kit";

export default defineConfig({
	out: "../migrations",
	schema: "../worker/db/schema.ts",
	dialect: "sqlite",
});
