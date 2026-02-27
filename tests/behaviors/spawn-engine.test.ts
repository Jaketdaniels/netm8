import { describe, expect, it } from "vitest";
import {
	createSimulatedStreamFromGenerateResult,
	parseTextToolCalls,
	repairMalformedToolCall,
} from "../../worker/services/spawn-engine";

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
	describe("given text-only function call output from the model", () => {
		it("extracts tool calls with nested JSON arguments", () => {
			const text = `
I'll call the tool now:
{"type":"function","name":"write_file","parameters":{"path":"src/index.ts","content":"const data = {\\"ok\\": true};\\nconsole.log(data);"}}
`;

			const calls = parseTextToolCalls(text);

			expect(calls).toBeTruthy();
			expect(calls?.length).toBe(1);
			expect(calls?.[0]).toMatchObject({
				toolName: "write_file",
			});
			expect(JSON.parse(calls?.[0]?.input ?? "{}")).toMatchObject({
				path: "src/index.ts",
			});
		});

		it("extracts OpenAI-style function wrapper payloads", () => {
			const text = `{"function":{"name":"exec","arguments":"{\\"command\\":\\"npm install\\"}"}}`;

			const calls = parseTextToolCalls(text);

			expect(calls).toBeTruthy();
			expect(calls?.length).toBe(1);
			expect(calls?.[0]).toMatchObject({
				toolName: "exec",
			});
			expect(JSON.parse(calls?.[0]?.input ?? "{}")).toMatchObject({
				command: "npm install",
			});
		});

		it("extracts tool calls when the model uses toolName/args keys", () => {
			const text = `{"toolName":"write_file","args":"{'path':'README.md','content':'hello'}"}`;

			const calls = parseTextToolCalls(text);

			expect(calls).toBeTruthy();
			expect(calls?.length).toBe(1);
			expect(calls?.[0]).toMatchObject({
				toolName: "write_file",
			});
			expect(JSON.parse(calls?.[0]?.input ?? "{}")).toMatchObject({
				path: "README.md",
				content: "hello",
			});
		});
	});

	describe("given malformed tool inputs from the model", () => {
		it("repairs single-quoted JSON input into valid JSON", async () => {
			const repaired = await repairMalformedToolCall({
				toolCall: {
					type: "tool-call",
					toolCallId: "tc_1",
					toolName: "exec",
					input: "{'command':'npm test'}",
				},
				tools: {},
				inputSchema: async () => ({ type: "object" }),
				system: undefined,
				messages: [],
				error: new Error("invalid input") as any,
			} as any);

			expect(repaired).toBeTruthy();
			expect(repaired?.input).toBe('{"command":"npm test"}');
		});
	});

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
