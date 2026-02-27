import { createFileRoute } from "@tanstack/react-router";
import { SchemaDisplay } from "@/components/ai-elements/schema-display";

export const Route = createFileRoute("/api-docs")({
	component: ApiDocs,
});

function ApiDocs() {
	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
			<h1 className="font-display text-2xl font-bold">API Documentation</h1>
			<p className="text-sm text-muted-foreground">All endpoints available on the NetM8 backend.</p>

			<div className="space-y-4">
				<SchemaDisplay
					method="GET"
					path="/api/health"
					description="Check D1, KV, R2 binding health"
					responseBody={[
						{ name: "name", type: "string", required: true },
						{ name: "version", type: "string", required: true },
						{ name: "env", type: "string", required: true },
						{
							name: "status",
							type: "string",
							required: true,
							description: "'healthy' or 'degraded'",
						},
						{
							name: "checks",
							type: "object",
							required: true,
							properties: [
								{ name: "d1", type: "string", required: true },
								{ name: "kv", type: "string", required: true },
								{ name: "r2", type: "string", required: true },
							],
						},
					]}
				/>

				<SchemaDisplay
					method="GET"
					path="/api/users"
					description="List all users"
					responseBody={[
						{ name: "id", type: "string", required: true },
						{ name: "email", type: "string", required: true },
						{ name: "name", type: "string" },
						{ name: "avatarUrl", type: "string" },
						{ name: "createdAt", type: "string", required: true },
						{ name: "updatedAt", type: "string", required: true },
					]}
				/>

				<SchemaDisplay
					method="GET"
					path="/api/users/{id}"
					description="Fetch user by ID"
					parameters={[{ name: "id", type: "string", required: true, location: "path" }]}
					responseBody={[
						{ name: "id", type: "string", required: true },
						{ name: "email", type: "string", required: true },
						{ name: "name", type: "string" },
						{ name: "avatarUrl", type: "string" },
						{ name: "createdAt", type: "string", required: true },
						{ name: "updatedAt", type: "string", required: true },
					]}
				/>

				<SchemaDisplay
					method="POST"
					path="/api/users"
					description="Create a new user"
					requestBody={[
						{ name: "email", type: "string", required: true, description: "Valid email address" },
						{ name: "name", type: "string", description: "1-200 characters" },
					]}
					responseBody={[
						{ name: "id", type: "string", required: true },
						{ name: "email", type: "string", required: true },
						{ name: "name", type: "string" },
						{ name: "avatarUrl", type: "string" },
						{ name: "createdAt", type: "string", required: true },
						{ name: "updatedAt", type: "string", required: true },
					]}
				/>

				<SchemaDisplay
					method="PUT"
					path="/api/users/{id}"
					description="Update a user"
					parameters={[{ name: "id", type: "string", required: true, location: "path" }]}
					requestBody={[
						{ name: "name", type: "string", description: "1-200 characters" },
						{ name: "avatarUrl", type: "string", description: "Valid URL" },
					]}
				/>

				<SchemaDisplay
					method="GET"
					path="/api/spawns"
					description="List all spawns (most recent first, max 50)"
					responseBody={[
						{ name: "id", type: "string", required: true },
						{ name: "prompt", type: "string", required: true },
						{ name: "name", type: "string" },
						{ name: "status", type: "string", required: true },
						{ name: "createdAt", type: "string", required: true },
					]}
				/>

				<SchemaDisplay
					method="GET"
					path="/api/spawns/{id}"
					description="Get spawn detail with files"
					parameters={[{ name: "id", type: "string", required: true, location: "path" }]}
					responseBody={[
						{ name: "id", type: "string", required: true },
						{ name: "prompt", type: "string", required: true },
						{ name: "name", type: "string" },
						{ name: "description", type: "string" },
						{ name: "platform", type: "string" },
						{ name: "features", type: "string", description: "JSON array" },
						{ name: "status", type: "string", required: true },
						{ name: "error", type: "string" },
						{ name: "buildLog", type: "string" },
						{
							name: "files",
							type: "array",
							required: true,
							items: {
								name: "file",
								type: "object",
								properties: [
									{ name: "id", type: "string", required: true },
									{ name: "path", type: "string", required: true },
									{ name: "content", type: "string", required: true },
									{ name: "language", type: "string" },
								],
							},
						},
					]}
				/>

				<SchemaDisplay
					method="GET"
					path="/api/spawns/{id}/files"
					description="List files for a spawn"
					parameters={[{ name: "id", type: "string", required: true, location: "path" }]}
				/>

				<SchemaDisplay
					method="GET"
					path="/api/spawns/{id}/files/{path}"
					description="Get raw file content"
					parameters={[
						{ name: "id", type: "string", required: true, location: "path" },
						{
							name: "path",
							type: "string",
							required: true,
							location: "path",
							description: "File path within spawn",
						},
					]}
				/>

				<SchemaDisplay
					method="DELETE"
					path="/api/spawns/{id}"
					description="Delete a spawn and all its files"
					parameters={[{ name: "id", type: "string", required: true, location: "path" }]}
				/>
			</div>
		</div>
	);
}
