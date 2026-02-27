import { describe, expect, it } from "vitest";
import { createSimulatedStreamFromGenerateResult } from "../../worker/services/spawn-engine";

async function readAllChunks(stream: ReadableStream<unknown>): Promise<unknown[]> {
	const reader = stream.getReader();
	const chunks: unknown[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return chunks;
}

describe("Spawn engine", () => {
	describe("given a simulated stream with tool calls", () => {
		it("emits V3 tool-call chunks with input fields", async () => {
			const stream = createSimulatedStreamFromGenerateResult({
				warnings: [],
				response: {
					id: "res_1",
					modelId: "test-model",
					timestamp: new Date().toISOString(),
				},
				content: [
					{
						type: "tool-call",
						toolCallId: "tc_1",
						toolName: "exec",
						input: '{"command":"npm test"}',
					},
				],
				finishReason: { unified: "tool-calls", raw: "tool-calls" },
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			});

			const chunks = await readAllChunks(stream);
			const toolCallChunk = chunks.find(
				(c): c is Record<string, unknown> =>
					typeof c === "object" && c !== null && (c as { type?: string }).type === "tool-call",
			);

			expect(toolCallChunk).toBeDefined();
			expect(toolCallChunk).toMatchObject({
				type: "tool-call",
				toolCallId: "tc_1",
				toolName: "exec",
				input: '{"command":"npm test"}',
			});
			expect(toolCallChunk).not.toHaveProperty("args");
			expect(toolCallChunk).not.toHaveProperty("toolCallType");
		});
	});
});
