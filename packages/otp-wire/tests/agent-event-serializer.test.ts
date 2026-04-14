import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serializeAgentEvent, deserializeAgentEvent } from "../src/agent-event-serializer.js";

describe("agent event serializer", () => {
	it("roundtrips agent_start event", () => {
		const event = { type: "agent_start" };
		const envelope = serializeAgentEvent(event);
		assert.strictEqual(envelope.eventType, "agent_start");
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips agent_end event with messages", () => {
		const event = { type: "agent_end", messages: [{ role: "assistant", content: "done" }] };
		const envelope = serializeAgentEvent(event);
		assert.strictEqual(envelope.eventType, "agent_end");
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips message_start event", () => {
		const event = { type: "message_start", message: { role: "assistant", content: "hello" } };
		const envelope = serializeAgentEvent(event);
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips message_update event", () => {
		const event = {
			type: "message_update",
			message: { role: "assistant", content: "world" },
			assistantMessageEvent: { type: "content_block_delta", delta: { text: "world" } },
		};
		const envelope = serializeAgentEvent(event);
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips message_end event", () => {
		const event = { type: "message_end", message: { role: "assistant", content: "complete" } };
		const envelope = serializeAgentEvent(event);
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips tool_execution_start event", () => {
		const event = {
			type: "tool_execution_start",
			toolCallId: "call_123",
			toolName: "bash",
			args: { command: "ls -la" },
		};
		const envelope = serializeAgentEvent(event);
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips tool_execution_end event", () => {
		const event = {
			type: "tool_execution_end",
			toolCallId: "call_123",
			toolName: "bash",
			result: { exitCode: 0, stdout: "file.txt" },
			isError: false,
		};
		const envelope = serializeAgentEvent(event);
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips turn_start event", () => {
		const event = { type: "turn_start" };
		const envelope = serializeAgentEvent(event);
		assert.strictEqual(envelope.eventType, "turn_start");
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips turn_end event", () => {
		const event = {
			type: "turn_end",
			message: { role: "assistant", content: "text" },
			toolResults: [],
		};
		const envelope = serializeAgentEvent(event);
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips queue_update event (session-level)", () => {
		const event = {
			type: "queue_update",
			steering: ["msg1", "msg2"],
			followUp: ["msg3"],
		};
		const envelope = serializeAgentEvent(event);
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("roundtrips compaction_start/end events", () => {
		const start = { type: "compaction_start", reason: "threshold" };
		const end = {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
		};
		const env1 = serializeAgentEvent(start);
		assert.deepStrictEqual(deserializeAgentEvent(env1), start);
		const env2 = serializeAgentEvent(end);
		assert.deepStrictEqual(deserializeAgentEvent(env2), end);
	});

	it("roundtrips auto_retry_start/end events", () => {
		const start = {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "overloaded",
		};
		const end = { type: "auto_retry_end", success: true, attempt: 1 };
		const env1 = serializeAgentEvent(start);
		assert.deepStrictEqual(deserializeAgentEvent(env1), start);
		const env2 = serializeAgentEvent(end);
		assert.deepStrictEqual(deserializeAgentEvent(env2), end);
	});

	it("handles unknown event types gracefully", () => {
		const event = { type: "custom_event", customField: "value" };
		const envelope = serializeAgentEvent(event);
		assert.strictEqual(envelope.eventType, "custom_event");
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});

	it("preserves timestamp", () => {
		const event = { type: "agent_start" };
		const envelope = serializeAgentEvent(event);
		assert.ok(envelope.timestamp);
		// Should be a valid ISO 8601 string
		assert.ok(!isNaN(Date.parse(envelope.timestamp)));
	});

	it("roundtrips event with deeply nested data", () => {
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
				],
			},
			assistantMessageEvent: {
				type: "content_block_start",
				contentBlock: { type: "tool_use", id: "call_1", name: "bash" },
			},
		};
		const envelope = serializeAgentEvent(event);
		const restored = deserializeAgentEvent(envelope);
		assert.deepStrictEqual(restored, event);
	});
});
