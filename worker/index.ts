export default {
	fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === "/api/" || url.pathname === "/api") {
			return Response.json({ name: "netm8", version: "0.1.0" });
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ error: "Not found" }, { status: 404 });
		}

		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
