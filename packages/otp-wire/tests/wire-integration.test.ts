import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PadManager } from "@cryptocode/otp-core";
import { DualChannel } from "@cryptocode/otp-gate";
import { WireServer } from "../src/ws-server.js";
import { WireClient } from "../src/ws-client.js";

// Create a DualChannel with synthetic pads (no network)
function createSyntheticChannel(
	uaByte: number,
	auByte: number,
	size = 50_000,
): DualChannel {
	const uaPad = new PadManager("synthetic://ua", Buffer.alloc(size, uaByte));
	const auPad = new PadManager("synthetic://au", Buffer.alloc(size, auByte));
	return new DualChannel(uaPad, auPad);
}

// Create paired channels: server and client share identical pad material
function createPairedChannels(): {
	serverChannel: DualChannel;
	clientChannel: DualChannel;
} {
	const uaBuf = Buffer.alloc(50_000, 0x42);
	const auBuf = Buffer.alloc(50_000, 0x24);
	return {
		serverChannel: new DualChannel(
			new PadManager("test://ua", Buffer.from(uaBuf)),
			new PadManager("test://au", Buffer.from(auBuf)),
		),
		clientChannel: new DualChannel(
			new PadManager("test://ua", Buffer.from(uaBuf)),
			new PadManager("test://au", Buffer.from(auBuf)),
		),
	};
}

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const net = require("node:net");
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

describe("wire integration", () => {
	let server: WireServer;
	let client: WireClient;
	let port: number;

	beforeEach(async () => {
		port = await getFreePort();
	});

	afterEach(async () => {
		client?.close();
		await server?.close();
	});

	it("server starts and client connects", async () => {
		const { serverChannel, clientChannel } = createPairedChannels();

		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: () => {},
		});

		await server.start();

		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});

		await client.connect();
		assert.strictEqual(client.isReady, true);

		// Wait for server to process client's HELLO response
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.strictEqual(server.isReady, true);
	});

	it("sends encrypted user message and receives it decrypted", async () => {
		const { serverChannel, clientChannel } = createPairedChannels();

		const instructions: string[] = [];
		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: (text) => instructions.push(text),
		});

		await server.start();

		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});

		await client.connect();
		await client.sendUserMessage("hello agent");

		// Wait for the server to process
		await new Promise((resolve) => setTimeout(resolve, 200));

		assert.strictEqual(instructions.length, 1);
		assert.strictEqual(instructions[0], "hello agent");
	});

	it("sends multiple messages in sequence", async () => {
		const { serverChannel, clientChannel } = createPairedChannels();

		const instructions: string[] = [];
		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: (text) => instructions.push(text),
		});

		await server.start();

		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});

		await client.connect();

		for (let i = 0; i < 5; i++) {
			await client.sendUserMessage(`message ${i}`);
		}

		await new Promise((resolve) => setTimeout(resolve, 500));

		assert.strictEqual(instructions.length, 5);
		for (let i = 0; i < 5; i++) {
			assert.strictEqual(instructions[i], `message ${i}`);
		}
	});

	it("sends agent events from server to client", async () => {
		const { serverChannel, clientChannel } = createPairedChannels();

		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: () => {},
		});

		await server.start();

		const receivedEvents: Record<string, unknown>[] = [];
		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});

		await client.connect();
		// Wait for server to become ready
		await new Promise((resolve) => setTimeout(resolve, 100));

		const unsub = client.onAgentEvent((event) => {
			receivedEvents.push(event);
		});

		await server.sendAgentEvent({ type: "agent_start" });
		await server.sendAgentEvent({ type: "message_start", message: { role: "assistant" } });
		await server.sendAgentEvent({ type: "agent_end", messages: [] });

		await new Promise((resolve) => setTimeout(resolve, 300));

		assert.strictEqual(receivedEvents.length, 3);
		assert.strictEqual(receivedEvents[0].type, "agent_start");
		assert.strictEqual(receivedEvents[1].type, "message_start");
		assert.strictEqual(receivedEvents[2].type, "agent_end");

		unsub();
	});

	it("streams 20 agent events in order", async () => {
		const { serverChannel, clientChannel } = createPairedChannels();

		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: () => {},
		});

		await server.start();

		const receivedEvents: string[] = [];
		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});

		await client.connect();
		// Wait for server to become ready
		await new Promise((resolve) => setTimeout(resolve, 100));
		client.onAgentEvent((event) => {
			receivedEvents.push(event.type as string);
		});

		for (let i = 0; i < 20; i++) {
			await server.sendAgentEvent({ type: "message_update", index: i });
		}

		await new Promise((resolve) => setTimeout(resolve, 1000));

		assert.strictEqual(receivedEvents.length, 20);
		for (let i = 0; i < 20; i++) {
			assert.strictEqual(receivedEvents[i], "message_update");
		}
	});

	it("unsubscribes from agent events", async () => {
		const { serverChannel, clientChannel } = createPairedChannels();

		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: () => {},
		});

		await server.start();

		const receivedEvents: Record<string, unknown>[] = [];
		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});

		await client.connect();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const unsub = client.onAgentEvent((event) => {
			receivedEvents.push(event);
		});

		await server.sendAgentEvent({ type: "agent_start" });
		await new Promise((resolve) => setTimeout(resolve, 200));

		unsub();

		await server.sendAgentEvent({ type: "agent_end", messages: [] });
		await new Promise((resolve) => setTimeout(resolve, 200));

		assert.strictEqual(receivedEvents.length, 1);
	});

	it("rejects connection with mismatched session hash", async () => {
		const { serverChannel } = createPairedChannels();
		// Different pad material → different hash
		const clientChannel = createSyntheticChannel(0xAA, 0xBB);

		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: () => {},
		});

		await server.start();

		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});

		// connect() should reject because negotiation fails (hash mismatch)
		await assert.rejects(
			async () => client.connect(),
			(err) => {
				assert.ok(!client.isReady, "Client should not be ready after mismatch");
				return true;
			},
		);
	});

	it("full bidirectional roundtrip: user msg → agent events", async () => {
		const { serverChannel, clientChannel } = createPairedChannels();

		const instructions: string[] = [];
		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: (text) => instructions.push(text),
		});

		await server.start();

		const receivedEvents: Record<string, unknown>[] = [];
		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});

		await client.connect();
		client.onAgentEvent((event) => receivedEvents.push(event));

		// User sends message
		await client.sendUserMessage("list files");
		await new Promise((resolve) => setTimeout(resolve, 200));

		assert.strictEqual(instructions[0], "list files");

		// Agent responds with streaming events
		await server.sendAgentEvent({ type: "turn_start" });
		await server.sendAgentEvent({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "ls" },
		});
		await server.sendAgentEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: "file1.txt\nfile2.txt",
			isError: false,
		});
		await server.sendAgentEvent({
			type: "turn_end",
			message: { role: "assistant", content: "Found 2 files" },
			toolResults: [],
		});

		await new Promise((resolve) => setTimeout(resolve, 500));

		assert.strictEqual(receivedEvents.length, 4);
		assert.strictEqual(receivedEvents[0].type, "turn_start");
		assert.strictEqual(receivedEvents[1].type, "tool_execution_start");
		assert.strictEqual(receivedEvents[2].type, "tool_execution_end");
		assert.strictEqual(receivedEvents[3].type, "turn_end");
	});
});
