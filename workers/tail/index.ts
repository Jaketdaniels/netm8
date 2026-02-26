interface Env {
	METRICS: AnalyticsEngineDataset;
	ALERT_WEBHOOK_URL?: string;
}

interface TailEvent {
	readonly scriptName: string;
	readonly event:
		| { readonly request: { readonly method: string; readonly url: string } }
		| Record<string, never>;
	readonly logs: ReadonlyArray<{
		readonly level: string;
		readonly message: readonly string[];
		readonly timestamp: number;
	}>;
	readonly exceptions: ReadonlyArray<{
		readonly name: string;
		readonly message: string;
		readonly timestamp: number;
	}>;
	readonly outcome: string;
}

interface StructuredLog {
	requestId: string;
	method: string;
	path: string;
	status: number;
	durationMs: number;
	error?: string;
}

function parseStructuredLog(messages: readonly string[]): StructuredLog | null {
	for (const msg of messages) {
		try {
			const parsed = JSON.parse(msg);
			if (parsed.requestId && parsed.method && parsed.path) {
				return parsed as StructuredLog;
			}
		} catch {
			// Not JSON, skip
		}
	}
	return null;
}

export default {
	async tail(events: TailEvent[], env: Env): Promise<void> {
		for (const event of events) {
			const log = parseStructuredLog(event.logs.flatMap((l) => l.message));
			const hasException = event.exceptions.length > 0;
			const isError = hasException || event.outcome !== "ok" || (log?.status ?? 0) >= 500;

			const path = log?.path ?? "unknown";
			const method = log?.method ?? "unknown";
			const errorMsg = hasException ? event.exceptions[0].message : (log?.error ?? "");

			env.METRICS.writeDataPoint({
				blobs: [path, method, errorMsg],
				doubles: [log?.status ?? 0, log?.durationMs ?? 0, isError ? 1 : 0],
				indexes: [log?.requestId ?? crypto.randomUUID()],
			});

			if (isError && env.ALERT_WEBHOOK_URL) {
				await fetch(env.ALERT_WEBHOOK_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						text: `[netm8] Error on ${method} ${path}: ${errorMsg || event.outcome}`,
						requestId: log?.requestId,
						status: log?.status,
					}),
				}).catch(() => {});
			}
		}
	},
};
