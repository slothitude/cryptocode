import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PadManager } from "@cryptocode/otp-core";
import { DualChannel } from "@cryptocode/otp-gate";
import { WireServer } from "../src/ws-server.js";
import { WireClient } from "../src/ws-client.js";

const PAD_SIZE = 50_000;

// Pre-computed pad buffers
function makeUA(): Buffer {
	const buf = Buffer.alloc(PAD_SIZE);
	for (let i = 0; i < PAD_SIZE; i++) buf[i] = (i * 37 + 17) & 0xff;
	return buf;
}
function makeAU(): Buffer {
	const buf = Buffer.alloc(PAD_SIZE);
	for (let i = 0; i < PAD_SIZE; i++) buf[i] = (i * 53 + 29) & 0xff;
	return buf;
}
function makeRecovery(): Buffer {
	const buf = Buffer.alloc(PAD_SIZE);
	for (let i = 0; i < PAD_SIZE; i++) buf[i] = (i * 71 + 13) & 0xff;
	return buf;
}

let seedServer: http.Server;
let seedPort: number;

// Serve pad data via HTTP so resync() can fetch it
function startSeedServer(routes: Map<string, Buffer>): Promise<http.Server> {
	return new Promise((resolve) => {
		seedServer = http.createServer((req, res) => {
			const buf = routes.get(req.url ?? "/");
			if (buf) {
				res.writeHead(200, { "Content-Type": "application/octet-stream" });
				res.end(buf);
			} else {
				res.writeHead(404);
				res.end("not found");
			}
		});
		seedServer.listen(0, () => {
			seedPort = (seedServer.address() as { port: number }).port;
			resolve(seedServer);
		});
	});
}

function createPairedChannels(uaUrl: string, auUrl: string, uaBuf: Buffer, auBuf: Buffer): {
	serverChannel: DualChannel;
	clientChannel: DualChannel;
} {
	return {
		serverChannel: new DualChannel(
			new PadManager(uaUrl, Buffer.from(uaBuf)),
			new PadManager(auUrl, Buffer.from(auBuf)),
		),
		clientChannel: new DualChannel(
			new PadManager(uaUrl, Buffer.from(uaBuf)),
			new PadManager(auUrl, Buffer.from(auBuf)),
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

/** Echo back the message as agent events (mirrors agent-server echo mode). */
async function echoBack(server: WireServer, text: string): Promise<void> {
	await server.sendAgentEvent({ type: "turn_start" });
	await server.sendAgentEvent({
		type: "message_start",
		message: { role: "assistant" },
	});
	await server.sendAgentEvent({
		type: "message_update",
		message: { role: "assistant", content: text },
	});
	await server.sendAgentEvent({
		type: "message_end",
		message: { role: "assistant", content: text },
	});
	await server.sendAgentEvent({
		type: "turn_end",
		message: { role: "assistant", content: text },
		toolResults: [],
	});
	await server.sendAgentEvent({ type: "agent_end", messages: [] });
}

describe("wobbly echo — desync recovery through wire protocol", () => {
	let server: WireServer;
	let client: WireClient;
	let port: number;
	const uaBuf = makeUA();
	const auBuf = makeAU();
	const recoveryBuf = makeRecovery();

	beforeEach(async () => {
		port = await getFreePort();
		await startSeedServer(new Map([
			["/ua", uaBuf],
			["/au", auBuf],
			["/recovery", recoveryBuf],
		]));
	});

	afterEach(async () => {
		client?.close();
		await server?.close();
		await new Promise<void>((r) => seedServer?.close(() => r()));
	});

	it("happy path: echo roundtrip authenticates and echoes", async () => {
		const { serverChannel, clientChannel } = createPairedChannels(
			`http://localhost:${seedPort}/ua`, `http://localhost:${seedPort}/au`,
			uaBuf, auBuf,
		);

		const instructions: Array<{ text: string; auth: boolean }> = [];
		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: async (text, authenticated) => {
				instructions.push({ text, auth: authenticated });
				if (authenticated) await echoBack(server, text);
			},
		});
		await server.start();

		const events: Record<string, unknown>[] = [];
		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});
		await client.connect();
		client.onAgentEvent((e) => events.push(e));

		await client.sendUserMessage("hello");
		await new Promise((r) => setTimeout(r, 300));

		assert.strictEqual(instructions.length, 1);
		assert.strictEqual(instructions[0].text, "hello");
		assert.strictEqual(instructions[0].auth, true);
		assert.ok(events.length >= 2, `Expected echo events, got ${events.length}`);
		assert.strictEqual(events[0].type, "turn_start");
	});

	it("detects desync and auto-recovers when server pad drifts", async () => {
		const uaUrl = `http://localhost:${seedPort}/ua`;
		const auUrl = `http://localhost:${seedPort}/au`;
		const { serverChannel, clientChannel } = createPairedChannels(uaUrl, auUrl, uaBuf, auBuf);

		const instructions: Array<{ text: string; auth: boolean }> = [];
		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: async (text, authenticated) => {
				instructions.push({ text, auth: authenticated });
				if (authenticated) await echoBack(server, text);
			},
		});
		await server.start();

		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});
		await client.connect();

		// First message works
		await client.sendUserMessage("msg1 ok");
		await new Promise((r) => setTimeout(r, 300));
		assert.strictEqual(instructions.length, 1);
		assert.strictEqual(instructions[0].auth, true);

		// Desync: advance server's U→A pad so positions diverge
		await serverChannel.userToAgent.advance(200);

		// Second message triggers desync detection + auto-recovery via resync()
		instructions.length = 0;
		await client.sendUserMessage("msg2 desync");
		await new Promise((r) => setTimeout(r, 500));

		// After desync detection, server sends RESYNC_REQUEST and calls recoverFromDesync()
		// which re-fetches the URL. Since we serve the same bytes, pads realign.
		// The desync message itself is NOT delivered to onInstruction — only the desync event fires.
		// The message is lost, which is the correct behavior for desync.

		// Verify post-recovery message works
		await client.sendUserMessage("msg3 recovered");
		await new Promise((r) => setTimeout(r, 300));

		// Should have the recovery message authenticated
		const authedMsgs = instructions.filter((i) => i.auth);
		assert.ok(
			authedMsgs.some((i) => i.text === "msg3 recovered"),
			"Post-recovery message should authenticate",
		);
	});

	it("recovers with fresh matching pads after full desync", async () => {
		const uaUrl = `http://localhost:${seedPort}/ua`;
		const auUrl = `http://localhost:${seedPort}/au`;
		const recoveryUrl = `http://localhost:${seedPort}/recovery`;

		// Phase 1: initial channels
		let serverChannel = new DualChannel(
			new PadManager(uaUrl, Buffer.from(uaBuf)),
			new PadManager(auUrl, Buffer.from(auBuf)),
		);
		let clientChannel = new DualChannel(
			new PadManager(uaUrl, Buffer.from(uaBuf)),
			new PadManager(auUrl, Buffer.from(auBuf)),
		);

		const instructions: Array<{ text: string; auth: boolean }> = [];
		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: async (text, authenticated) => {
				instructions.push({ text, auth: authenticated });
				if (authenticated) await echoBack(server, text);
			},
		});
		await server.start();

		const events: Record<string, unknown>[] = [];
		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});
		await client.connect();
		client.onAgentEvent((e) => events.push(e));

		// Successful exchange
		await client.sendUserMessage("before wobbly");
		await new Promise((r) => setTimeout(r, 300));
		assert.strictEqual(instructions[0].auth, true);

		// Phase 2: cause desync
		await serverChannel.userToAgent.advance(300);
		instructions.length = 0;
		await client.sendUserMessage("during wobbly");
		await new Promise((r) => setTimeout(r, 300));

		// Phase 3: wobbly recovery — tear down and rebuild with fresh matching pads
		await server.close();
		client.close();

		serverChannel = new DualChannel(
			new PadManager(recoveryUrl, Buffer.from(recoveryBuf)),
			new PadManager(recoveryUrl, Buffer.alloc(PAD_SIZE)),
		);
		clientChannel = new DualChannel(
			new PadManager(recoveryUrl, Buffer.from(recoveryBuf)),
			new PadManager(recoveryUrl, Buffer.alloc(PAD_SIZE)),
		);

		const newPort = await getFreePort();
		instructions.length = 0;

		const recoveredServer = new WireServer({
			port: newPort,
			channel: serverChannel,
			onInstruction: async (text, authenticated) => {
				instructions.push({ text, auth: authenticated });
				if (authenticated) await echoBack(recoveredServer, text);
			},
		});
		await recoveredServer.start();

		const recoveredClient = new WireClient({
			url: `ws://localhost:${newPort}`,
			channel: clientChannel,
		});
		await recoveredClient.connect();

		const recoveredEvents: Record<string, unknown>[] = [];
		recoveredClient.onAgentEvent((e) => recoveredEvents.push(e));

		// Post-recovery: should authenticate again
		await recoveredClient.sendUserMessage("after wobbly");
		await new Promise((r) => setTimeout(r, 300));

		assert.strictEqual(instructions.length, 1);
		assert.strictEqual(instructions[0].auth, true, "Should authenticate after recovery");
		assert.strictEqual(instructions[0].text, "after wobbly");
		assert.ok(recoveredEvents.length >= 2, `Expected echo events, got ${recoveredEvents.length}`);

		await recoveredServer.close();
		recoveredClient.close();
	});

	it("server detects desync and emits desync event with recovery info", async () => {
		const uaUrl = `http://localhost:${seedPort}/ua`;
		const auUrl = `http://localhost:${seedPort}/au`;
		const { serverChannel, clientChannel } = createPairedChannels(uaUrl, auUrl, uaBuf, auBuf);

		server = new WireServer({
			port,
			channel: serverChannel,
			onInstruction: async (text, authenticated) => {
				if (authenticated) await echoBack(server, text);
			},
		});
		await server.start();

		client = new WireClient({
			url: `ws://localhost:${port}`,
			channel: clientChannel,
		});
		await client.connect();

		// First message ok
		await client.sendUserMessage("ok");
		await new Promise((r) => setTimeout(r, 200));

		// Desync: advance server pad
		await serverChannel.userToAgent.advance(100);

		// Capture desync events
		const desyncEvents: Array<{ channel: string; dsync: { senderSeq: number; receiverSeq: number; recoveryUrl: string } }> = [];
		server.on("desync", (channel, dsync) => {
			desyncEvents.push({ channel, dsync });
		});

		// Send message that triggers desync
		await client.sendUserMessage("wobbly");
		await new Promise((r) => setTimeout(r, 500));

		assert.strictEqual(desyncEvents.length, 1, "Should emit one desync event");
		assert.strictEqual(desyncEvents[0].channel, "userToAgent");
		assert.ok(desyncEvents[0].dsync.recoveryUrl, "Should include recovery URL");
		assert.ok(
			desyncEvents[0].dsync.senderSeq !== desyncEvents[0].dsync.receiverSeq,
			"Sender and receiver seq should differ",
		);
	});
});
