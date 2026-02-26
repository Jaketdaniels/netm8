#!/usr/bin/env node
// scripts/seed.mjs — Seeds local D1 with sample data

import { execSync } from "node:child_process";

const users = [
	{ email: "alice@example.com", name: "Alice Johnson" },
	{ email: "bob@example.com", name: "Bob Smith" },
	{ email: "carol@example.com", name: "Carol Williams" },
	{ email: "dave@example.com", name: "Dave Brown" },
	{ email: "eve@example.com", name: "Eve Davis" },
	{ email: "frank@example.com", name: "Frank Miller" },
	{ email: "grace@example.com", name: "Grace Wilson" },
	{ email: "hank@example.com", name: "Hank Moore" },
	{ email: "iris@example.com", name: "Iris Taylor" },
	{ email: "jack@example.com", name: "Jack Anderson" },
];

const values = users.map((u) => `('${u.email}', '${u.name}')`).join(",\n  ");

const sql = `INSERT OR IGNORE INTO users (email, name) VALUES\n  ${values};`;

console.log("Seeding local D1 database...");
execSync(`npx wrangler d1 execute netm8-db --local --command "${sql.replace(/"/g, '\\"')}"`, {
	stdio: "inherit",
});
console.log("Done! Seeded 10 users.");
