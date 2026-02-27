import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Agent, AgentContent, AgentHeader } from "@/components/ai-elements/agent";
import {
	EnvironmentVariable,
	EnvironmentVariables,
	EnvironmentVariablesContent,
	EnvironmentVariablesHeader,
	EnvironmentVariablesTitle,
	EnvironmentVariablesToggle,
} from "@/components/ai-elements/environment-variables";
import {
	VoiceSelector,
	VoiceSelectorContent,
	VoiceSelectorInput,
	VoiceSelectorItem,
	VoiceSelectorList,
	VoiceSelectorName,
	VoiceSelectorTrigger,
} from "@/components/ai-elements/voice-selector";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "../api";

export const Route = createFileRoute("/profile")({
	component: Profile,
});

function Profile() {
	const queryClient = useQueryClient();
	const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
	const [selectedVoice, setSelectedVoice] = useState<string | undefined>();

	useEffect(() => {
		const loadVoices = () => {
			const available = window.speechSynthesis.getVoices();
			if (available.length > 0) setVoices(available);
		};
		loadVoices();
		window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
		return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
	}, []);

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

	const [createEmail, setCreateEmail] = useState("");
	const [createName, setCreateName] = useState("");

	const createUser = useMutation({
		mutationFn: async ({ email, name }: { email: string; name?: string }) => {
			const body: { email: string; name?: string } = { email };
			if (name) body.name = name;
			const res = await api.api.users.$post({ json: body });
			if (!res.ok) throw new Error("Failed to create user");
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users"] });
			setCreateEmail("");
			setCreateName("");
		},
	});

	const handleCreateSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (!createEmail.trim()) return;
		createUser.mutate({ email: createEmail, name: createName || undefined });
	};

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
			<div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
				<h1 className="font-display text-2xl font-bold">Create Profile</h1>
				<Card>
					<CardHeader>
						<CardTitle className="font-display">Get Started</CardTitle>
					</CardHeader>
					<CardContent>
						<form onSubmit={handleCreateSubmit} className="flex flex-col gap-4">
							<div className="flex flex-col gap-1.5">
								<label htmlFor="create-email" className="text-sm font-medium">
									Email <span className="text-destructive">*</span>
								</label>
								<Input
									id="create-email"
									type="email"
									placeholder="you@example.com"
									value={createEmail}
									onChange={(e) => setCreateEmail(e.target.value)}
									required
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<label htmlFor="create-name" className="text-sm font-medium">
									Name
								</label>
								<Input
									id="create-name"
									placeholder="Your name"
									value={createName}
									onChange={(e) => setCreateName(e.target.value)}
								/>
							</div>
							<Button type="submit" disabled={createUser.isPending || !createEmail.trim()}>
								{createUser.isPending ? "Creating..." : "Create Profile"}
							</Button>
							{createUser.isError && (
								<p className="text-sm text-destructive-foreground">{createUser.error.message}</p>
							)}
						</form>
					</CardContent>
				</Card>
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

			{/* Voice Selector (S5) */}
			{voices.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="font-display">Voice Preference</CardTitle>
					</CardHeader>
					<CardContent>
						<VoiceSelector value={selectedVoice} onValueChange={setSelectedVoice}>
							<VoiceSelectorTrigger asChild>
								<Button variant="outline" className="w-full justify-start">
									{selectedVoice
										? (voices.find((v) => v.name === selectedVoice)?.name ?? "Select voice")
										: "Select voice for TTS"}
								</Button>
							</VoiceSelectorTrigger>
							<VoiceSelectorContent>
								<VoiceSelectorInput placeholder="Search voices..." />
								<VoiceSelectorList>
									{voices.map((v) => (
										<VoiceSelectorItem
											key={v.name}
											value={v.name}
											onSelect={() => setSelectedVoice(v.name)}
										>
											<VoiceSelectorName>{v.name}</VoiceSelectorName>
											<span className="text-xs text-muted-foreground">{v.lang}</span>
										</VoiceSelectorItem>
									))}
								</VoiceSelectorList>
							</VoiceSelectorContent>
						</VoiceSelector>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
