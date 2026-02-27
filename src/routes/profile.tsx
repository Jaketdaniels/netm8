import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Agent, AgentContent, AgentHeader } from "@/components/ai-elements/agent";
import {
	EnvironmentVariable,
	EnvironmentVariables,
	EnvironmentVariablesContent,
	EnvironmentVariablesHeader,
	EnvironmentVariablesTitle,
	EnvironmentVariablesToggle,
} from "@/components/ai-elements/environment-variables";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "../api";

export const Route = createFileRoute("/profile")({
	component: Profile,
});

function Profile() {
	const queryClient = useQueryClient();

	const users = useQuery({
		queryKey: ["users"],
		queryFn: async () => {
			const res = await api.api.users.$get();
			if (!res.ok) throw new Error("Failed to fetch users");
			return res.json();
		},
	});

	const user = users.data?.[0];

	const [name, setName] = useState("");
	const [avatarUrl, setAvatarUrl] = useState("");

	const updateUser = useMutation({
		mutationFn: async ({
			id,
			name,
			avatarUrl,
		}: {
			id: string;
			name?: string;
			avatarUrl?: string;
		}) => {
			const body: Record<string, string> = {};
			if (name) body.name = name;
			if (avatarUrl) body.avatarUrl = avatarUrl;
			const res = await api.api.users[":id"].$put({ param: { id }, json: body });
			if (!res.ok) throw new Error("Failed to update user");
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users"] });
			setName("");
			setAvatarUrl("");
		},
	});

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (!user) return;
		updateUser.mutate({
			id: user.id,
			name: name || undefined,
			avatarUrl: avatarUrl || undefined,
		});
	};

	if (users.isLoading) {
		return (
			<div className="mx-auto flex max-w-5xl flex-col items-center p-6">
				<p className="text-sm text-muted-foreground">Loading profile...</p>
			</div>
		);
	}

	if (users.error) {
		return (
			<div className="mx-auto flex max-w-5xl flex-col items-center p-6">
				<p className="text-sm text-destructive-foreground">Error: {users.error.message}</p>
			</div>
		);
	}

	if (!user) {
		return (
			<div className="mx-auto flex max-w-5xl flex-col items-center p-6">
				<h1 className="mb-4 font-display text-3xl font-bold tracking-tight">Profile</h1>
				<p className="text-muted-foreground">No users yet</p>
			</div>
		);
	}

	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
			<h1 className="font-display text-2xl font-bold">Profile</h1>

			<Agent>
				<AgentHeader name={user.name ?? user.email} />
				<AgentContent>
					<p className="text-sm text-muted-foreground">{user.email}</p>
					{user.avatarUrl && (
						<img
							src={user.avatarUrl}
							alt={user.name ?? "Avatar"}
							className="size-16 rounded-full object-cover"
						/>
					)}
				</AgentContent>
			</Agent>

			<EnvironmentVariables defaultShowValues>
				<EnvironmentVariablesHeader>
					<EnvironmentVariablesTitle>User Details</EnvironmentVariablesTitle>
					<EnvironmentVariablesToggle />
				</EnvironmentVariablesHeader>
				<EnvironmentVariablesContent>
					<EnvironmentVariable name="ID" value={user.id} />
					<EnvironmentVariable name="EMAIL" value={user.email} />
					<EnvironmentVariable name="NAME" value={user.name ?? "—"} />
					<EnvironmentVariable name="AVATAR_URL" value={user.avatarUrl ?? "—"} />
					<EnvironmentVariable name="CREATED_AT" value={user.createdAt} />
					<EnvironmentVariable name="UPDATED_AT" value={user.updatedAt} />
				</EnvironmentVariablesContent>
			</EnvironmentVariables>

			<Card>
				<CardHeader>
					<CardTitle className="font-display">Update Profile</CardTitle>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<div className="flex flex-col gap-1.5">
							<label htmlFor="profile-name" className="text-sm font-medium">
								Name
							</label>
							<Input
								id="profile-name"
								placeholder={user.name ?? "Enter name"}
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="profile-avatar" className="text-sm font-medium">
								Avatar URL
							</label>
							<Input
								id="profile-avatar"
								type="url"
								placeholder={user.avatarUrl ?? "https://example.com/avatar.png"}
								value={avatarUrl}
								onChange={(e) => setAvatarUrl(e.target.value)}
							/>
						</div>
						<Button type="submit" disabled={updateUser.isPending || (!name && !avatarUrl)}>
							{updateUser.isPending ? "Saving..." : "Save Changes"}
						</Button>
						{updateUser.isError && (
							<p className="text-sm text-destructive-foreground">{updateUser.error.message}</p>
						)}
						{updateUser.isSuccess && (
							<p className="text-sm text-green-600">Profile updated successfully.</p>
						)}
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
