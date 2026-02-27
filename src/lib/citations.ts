const PLATFORM_DOCS: Record<string, { url: string; title: string }> = {
	web: { url: "https://developer.mozilla.org/en-US/docs/Web", title: "MDN Web Docs" },
	ios: { url: "https://developer.apple.com/documentation/", title: "Apple Developer" },
	android: { url: "https://developer.android.com/docs", title: "Android Docs" },
	desktop: { url: "https://www.electronjs.org/docs", title: "Electron Docs" },
	cli: { url: "https://nodejs.org/docs/latest/api/", title: "Node.js API" },
	api: { url: "https://swagger.io/docs/specification/", title: "OpenAPI Spec" },
};

const PACKAGE_DOCS: Record<string, { url: string; title: string }> = {
	react: { url: "https://react.dev", title: "React" },
	vue: { url: "https://vuejs.org", title: "Vue.js" },
	express: { url: "https://expressjs.com", title: "Express" },
	hono: { url: "https://hono.dev", title: "Hono" },
	next: { url: "https://nextjs.org/docs", title: "Next.js" },
	tailwindcss: { url: "https://tailwindcss.com/docs", title: "Tailwind CSS" },
	prisma: { url: "https://www.prisma.io/docs", title: "Prisma" },
	drizzle: { url: "https://orm.drizzle.team/docs", title: "Drizzle ORM" },
	zod: { url: "https://zod.dev", title: "Zod" },
	vite: { url: "https://vite.dev", title: "Vite" },
	vitest: { url: "https://vitest.dev", title: "Vitest" },
	typescript: { url: "https://www.typescriptlang.org/docs/", title: "TypeScript" },
};

export function getPlatformCitation(platform: string) {
	return PLATFORM_DOCS[platform] ?? null;
}

export function getPackageCitation(packageName: string) {
	const key = packageName.replace(/^@[^/]+\//, "").split("/")[0];
	return PACKAGE_DOCS[key] ?? null;
}
