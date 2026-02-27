import { describe, expect, it } from "vitest";
import {
	BUILD_SYSTEM_PROMPT,
	BUILD_TOOL_NAMES,
	buildSystemPrompt,
	createSimulatedStreamFromGenerateResult,
	parseTextToolCalls,
	repairMalformedToolCall,
	stopWhenDoneWithFiles,
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

		it("extracts llama-style bracketed function calls", () => {
			const text =
				'[write_file(path="src/index.ts", content="console.log(1)"), exec(command="npm test")]';
			const calls = parseTextToolCalls(text);

			expect(calls).toBeTruthy();
			expect(calls?.length).toBe(2);
			expect(calls?.[0]).toMatchObject({ toolName: "write_file" });
			expect(calls?.[1]).toMatchObject({ toolName: "exec" });
			expect(JSON.parse(calls?.[0]?.input ?? "{}")).toMatchObject({
				path: "src/index.ts",
				content: "console.log(1)",
			});
			expect(JSON.parse(calls?.[1]?.input ?? "{}")).toMatchObject({
				command: "npm test",
			});
		});

		it("ignores function-call JSON with unknown tool names", () => {
			const text = `{"name":"unknown_tool","parameters":{"foo":"bar"}}`;
			const calls = parseTextToolCalls(text);
			expect(calls).toBeNull();
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

	describe("given stop conditions for build completion", () => {
		it("does not stop on done when no files were written", () => {
			const stop = stopWhenDoneWithFiles(new Map());
			const shouldStop = stop({
				steps: [{ toolResults: [{ toolName: "done" }] }] as any,
			});
			expect(shouldStop).toBe(false);
		});

		it("stops only after done result and at least one file", () => {
			const files = new Map<string, string>([["package.json", '{"name":"x"}']]);
			const stop = stopWhenDoneWithFiles(files);

			const withoutDone = stop({
				steps: [{ toolResults: [{ toolName: "exec" }] }] as any,
			});
			const withDone = stop({
				steps: [{ toolResults: [{ toolName: "done" }] }] as any,
			});

			expect(withoutDone).toBe(false);
			expect(withDone).toBe(true);
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

	describe("given system prompt and tool contract", () => {
		it("keeps prompt instructions aligned with supported build tools", () => {
			const feedbackPrompt = buildSystemPrompt("feedback", "Add a dark mode toggle.");

			expect(BUILD_SYSTEM_PROMPT).toContain(
				"<|begin_of_text|><|start_header_id|>system<|end_header_id|>",
			);
			for (const toolName of BUILD_TOOL_NAMES) {
				expect(BUILD_SYSTEM_PROMPT).toContain(toolName);
			}
			expect(BUILD_SYSTEM_PROMPT).toContain('"name": "write_file"');
			expect(BUILD_SYSTEM_PROMPT).toContain('"name": "read_file"');
			expect(BUILD_SYSTEM_PROMPT).toContain('"name": "exec"');
			expect(BUILD_SYSTEM_PROMPT).toContain('"name": "done"');
			expect(BUILD_SYSTEM_PROMPT).toContain(
				"[func_name1(param_name1=param_value1, param_name2=param_value2), func_name2(...)]",
			);
			expect(BUILD_SYSTEM_PROMPT).toContain(
				"done() will fail unless at least one file has been written.",
			);
			expect(feedbackPrompt).toContain("User feedback: Add a dark mode toggle.");
		});
	});
});
