import { WebSocketServer, type WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { DualChannel } from "@cryptocode/otp-gate";
import { FrameType } from "./types.js";
import type { WireFrame, ControlMessage, AgentEventEnvelope } from "./types.js";
import {
	encodeFrame,
	decodeFrame,
	encodeControlMessage,
	decodeControlMessage,
	encodeEncryptedPayload,
	decodeEncryptedPayload,
} from "./frame-codec.js";
import {
	serializeAgentEvent,
	deserializeAgentEvent,
} from "./agent-event-serializer.js";
import { SessionNegotiator, type NegotiationResult } from "./session-negotiator.js";

export interface WireServerOptions {
	/** Port to listen on. */
	port: number;
	/** DualChannel for encryption/decryption (agent side). */
	channel: DualChannel;
	/** Called when a decrypted, authenticated user instruction arrives. */
	onInstruction: (text: string, authenticated: boolean) => void;
	/** Called when negotiation completes. */
	onReady?: () => void;
	/** Keepalive interval in ms (default 30000). */
	keepaliveMs?: number;
}

type ServerState = "waiting" | "negotiating" | "ready" | "closed";

/**
 * WebSocket server for the agent process.
 *
 * - Accepts one client connection at a time
 * - Performs session negotiation on connect
 * - Decrypts incoming USER_INSTRUCTION frames and calls onInstruction
 * - Provides sendAgentEvent() to encrypt and send streaming events
 * - Handles desync recovery and keepalive
 */
export class WireServer extends EventEmitter {
	private readonly options: WireServerOptions;
	private readonly channel: DualChannel;
	private wss: WebSocketServer | null = null;
	private client: WebSocket | null = null;
	private state: ServerState = "waiting";
	private sendSequence = 0;
	private recvSequence = 0;
	private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	private negotiator: SessionNegotiator | null = null;
	private recvBuffer = Buffer.alloc(0);

	constructor(options: WireServerOptions) {
		super();
		this.options = options;
		this.channel = options.channel;
	}

	/** Start listening for connections. */
	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.wss = new WebSocketServer({ port: this.options.port });

			this.wss.on("error", reject);

			this.wss.on("listening", () => {
				this.emit("listening", this.options.port);
				resolve();
			});

			this.wss.on("connection", (ws) => {
				if (this.client) {
					ws.close(4001, "Only one client allowed");
					return;
				}
				this.handleConnection(ws);
			});
		});
	}

	/** Stop the server and disconnect. */
	async close(): Promise<void> {
		this.state = "closed";
		this.stopKeepalive();
		if (this.client) {
			this.sendControl({ type: "SHUTDOWN", reason: "server closing" });
			this.client.close();
			this.client = null;
		}
		if (this.wss) {
			return new Promise((resolve) => {
				this.wss!.close(() => resolve());
			});
		}
	}

	/** Get the port the server is listening on. */
	get port(): number {
		return this.options.port;
	}

	/** Whether the server is ready to exchange messages. */
	get isReady(): boolean {
		return this.state === "ready";
	}

	/**
	 * Send an agent event: serialize → encrypt → send as AGENT_EVENT frame.
	 */
	async sendAgentEvent(event: Record<string, unknown>): Promise<void> {
		if (!this.client || this.state !== "ready") {
			throw new Error("Cannot send event: not connected");
		}

		const envelope = serializeAgentEvent(event);
		const payload = Buffer.from(JSON.stringify(envelope), "utf-8");

		// Encrypt the serialized event
		const encrypted = await this.channel.encryptAgentResponse(payload.toString("utf-8"));
		const wirePayload = encodeEncryptedPayload(encrypted);

		const frame: WireFrame = {
			type: FrameType.AGENT_EVENT,
			sequence: this.sendSequence++,
			payload: wirePayload,
		};

		this.client.send(encodeFrame(frame));
	}

	private handleConnection(ws: WebSocket): void {
		this.client = ws;
		this.state = "negotiating";
		this.recvBuffer = Buffer.alloc(0);
		this.sendSequence = 0;
		this.recvSequence = 0;

		ws.on("message", (data: Buffer) => this.handleData(data));
		ws.on("close", () => {
			this.emit("client-disconnected");
			this.client = null;
			this.state = "waiting";
			this.stopKeepalive();
		});
		ws.on("error", (err) => {
			this.emit("error", err);
		});

		// Start negotiation: send HELLO
		this.negotiator = new SessionNegotiator("server", this.channel);
		const hello = this.negotiator.startLocalNegotiation();
		this.sendControl(hello);
	}

	private handleData(data: Buffer): void {
		this.recvBuffer = Buffer.concat([this.recvBuffer, data]);

		while (this.recvBuffer.length > 0) {
			const frameLength = this.getBufferedFrameLength();
			if (frameLength === null || this.recvBuffer.length < frameLength) break;

			const frameBuf = this.recvBuffer.subarray(0, frameLength);
			this.recvBuffer = Buffer.from(this.recvBuffer.subarray(frameLength));

			const frame = decodeFrame(frameBuf);
			if (!frame) continue;

			this.handleFrame(frame);
		}
	}

	private handleFrame(frame: WireFrame): void {
		switch (frame.type) {
			case FrameType.USER_INSTRUCTION:
				this.handleUserInstruction(frame);
				break;
			case FrameType.CONTROL:
				this.handleControlFrame(frame);
				break;
			case FrameType.AGENT_EVENT:
				// Server shouldn't receive AGENT_EVENT, but ignore gracefully
				break;
		}
	}

	private async handleUserInstruction(frame: WireFrame): Promise<void> {
		if (this.state !== "ready") return;

		try {
			const encrypted = decodeEncryptedPayload(frame.payload);
			const result = await this.channel.decryptUserMessage(encrypted);

			if (result.authenticated) {
				// Could be desync info check
			}

			if (result.dsync) {
				// Desync detected — request resync
				this.sendControl({
					type: "RESYNC_REQUEST",
					channel: "userToAgent",
					recoveryUrl: result.dsync.recoveryUrl,
				});
				await this.channel.recoverFromDesync("userToAgent");
				this.emit("desync", "userToAgent", result.dsync);
			} else {
				this.options.onInstruction(result.instruction, result.authenticated);
			}
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	private handleControlFrame(frame: WireFrame): void {
		try {
			const msg = decodeControlMessage(frame.payload);
			this.handleControlMessage(msg);
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	private handleControlMessage(msg: ControlMessage): void {
		switch (msg.type) {
			case "HELLO":
				if (this.negotiator) {
					const result = this.negotiator.completeLocalNegotiation(msg);
					if (result.success) {
						this.state = "ready";
						this.startKeepalive();
						this.options.onReady?.();
						this.emit("ready");
					} else {
						this.sendControl({
							type: "ERROR",
							message: result.error ?? "Negotiation failed",
						});
					}
				}
				break;

			case "PING":
				this.sendControl({ type: "PONG" });
				break;

			case "PONG":
				// Keepalive response — nothing to do
				break;

			case "RESYNC_REQUEST":
				this.handleResyncRequest(msg);
				break;

			case "RESYNC_ACK":
				this.emit("resync-ack", msg.channel);
				break;

			case "SHUTDOWN":
				this.emit("shutdown", msg.reason);
				this.close();
				break;

			case "ERROR":
				this.emit("remote-error", msg.message);
				break;
		}
	}

	private async handleResyncRequest(
		msg: { type: "RESYNC_REQUEST"; channel: "userToAgent" | "agentToUser"; recoveryUrl: string },
	): Promise<void> {
		try {
			await this.channel.recoverFromDesync(msg.channel);
			this.sendControl({ type: "RESYNC_ACK", channel: msg.channel });
			this.emit("resynced", msg.channel);
		} catch (err) {
			this.sendControl({
				type: "ERROR",
				message: `Resync failed: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	private sendControl(msg: ControlMessage): void {
		if (!this.client) return;
		const frame: WireFrame = {
			type: FrameType.CONTROL,
			sequence: this.sendSequence++,
			payload: encodeControlMessage(msg),
		};
		this.client.send(encodeFrame(frame));
	}

	private startKeepalive(): void {
		const interval = this.options.keepaliveMs ?? 30_000;
		this.keepaliveTimer = setInterval(() => {
			if (this.client && this.state === "ready") {
				this.sendControl({ type: "PING" });
			}
		}, interval);
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
	}

	private getBufferedFrameLength(): number | null {
		return this.recvBuffer.length >= 9
			? 9 + this.recvBuffer.readUInt32BE(5)
			: null;
	}
}
