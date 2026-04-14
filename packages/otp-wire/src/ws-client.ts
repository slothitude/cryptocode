import WebSocket from "ws";
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
import { SessionNegotiator } from "./session-negotiator.js";

export type AgentEventCallback = (event: Record<string, unknown>) => void;

export interface WireClientOptions {
	/** WebSocket URL of the agent server. */
	url: string;
	/** DualChannel for encryption/decryption (user/TUI side). */
	channel: DualChannel;
	/** Called when negotiation completes. */
	onReady?: () => void;
	/** Keepalive interval in ms (default 30000). */
	keepaliveMs?: number;
}

type ClientState = "connecting" | "negotiating" | "ready" | "closed";

/**
 * WebSocket client for the TUI process.
 *
 * - Connects to the agent's WireServer
 * - Performs session negotiation on connect
 * - Provides sendUserMessage() to encrypt and send instructions
 * - Emits agent events via onAgentEvent() callback registration
 * - Handles desync recovery and keepalive
 */
export class WireClient extends EventEmitter {
	private readonly options: WireClientOptions;
	private readonly channel: DualChannel;
	private ws: WebSocket | null = null;
	private state: ClientState = "connecting";
	private sendSequence = 0;
	private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	private negotiator: SessionNegotiator | null = null;
	private eventCallbacks = new Set<AgentEventCallback>();
	private recvBuffer = Buffer.alloc(0);

	constructor(options: WireClientOptions) {
		super();
		this.options = options;
		this.channel = options.channel;
	}

	/** Connect to the agent server and perform negotiation. */
	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.state = "connecting";
			this.ws = new WebSocket(this.options.url);

			this.ws.on("open", () => {
				this.state = "negotiating";
				this.emit("connected");
			});

			this.ws.on("message", (data: Buffer) => this.handleData(data));

			this.ws.on("close", (code, reason) => {
				this.state = "closed";
				this.stopKeepalive();
				this.emit("disconnected", code, reason.toString());
				reject(new Error(`Connection closed: ${code} ${reason}`));
			});

			this.ws.on("error", (err) => {
				if (this.state === "connecting") {
					reject(err);
				} else {
					this.emit("error", err);
				}
			});

			// Resolve when negotiation completes
			this.once("ready", () => resolve());
		});
	}

	/** Disconnect from the server. */
	close(): void {
		this.state = "closed";
		this.stopKeepalive();
		if (this.ws) {
			this.sendControl({ type: "SHUTDOWN" });
			this.ws.close();
			this.ws = null;
		}
	}

	/** Whether the client is connected and ready. */
	get isReady(): boolean {
		return this.state === "ready";
	}

	/**
	 * Send a user message: encrypt → send as USER_INSTRUCTION frame.
	 */
	async sendUserMessage(text: string): Promise<void> {
		if (!this.ws || this.state !== "ready") {
			throw new Error("Cannot send message: not connected");
		}

		const encrypted = await this.channel.encryptUserMessage(text);
		const wirePayload = encodeEncryptedPayload(encrypted);

		const frame: WireFrame = {
			type: FrameType.USER_INSTRUCTION,
			sequence: this.sendSequence++,
			payload: wirePayload,
		};

		this.ws.send(encodeFrame(frame));
	}

	/**
	 * Register a callback for agent events.
	 * Returns an unsubscribe function.
	 */
	onAgentEvent(callback: AgentEventCallback): () => void {
		this.eventCallbacks.add(callback);
		return () => {
			this.eventCallbacks.delete(callback);
		};
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
			case FrameType.AGENT_EVENT:
				this.handleAgentEvent(frame);
				break;
			case FrameType.CONTROL:
				this.handleControlFrame(frame);
				break;
			case FrameType.USER_INSTRUCTION:
				// Client shouldn't receive USER_INSTRUCTION, ignore
				break;
		}
	}

	private async handleAgentEvent(frame: WireFrame): Promise<void> {
		if (this.state !== "ready") return;

		try {
			const encrypted = decodeEncryptedPayload(frame.payload);
			const result = await this.channel.decryptAgentResponse(encrypted);

			if (result.authenticated) {
				const envelope: AgentEventEnvelope = JSON.parse(result.instruction);
				const event = deserializeAgentEvent(envelope);
				for (const cb of this.eventCallbacks) {
					try {
						cb(event);
					} catch {
						// Don't let callback errors break the loop
					}
				}
			} else if (result.dsync) {
				// Desync on A→U channel
				this.emit("desync", "agentToUser", result.dsync);
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
				if (this.state === "negotiating") {
					this.negotiator = new SessionNegotiator("client", this.channel);
					const response = this.negotiator.completeLocalNegotiation(msg);
					if (response.success) {
						// Send our own HELLO back
						const ourHello = this.negotiator.startLocalNegotiation();
						this.sendControl(ourHello);
						this.state = "ready";
						this.startKeepalive();
						this.options.onReady?.();
						this.emit("ready");
					} else {
						this.sendControl({
							type: "ERROR",
							message: response.error ?? "Negotiation failed",
						});
						// Close to reject the connect() promise
						this.ws?.close(4003, "negotiation failed");
					}
				}
				break;

			case "PING":
				this.sendControl({ type: "PONG" });
				break;

			case "PONG":
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
		if (!this.ws) return;
		const frame: WireFrame = {
			type: FrameType.CONTROL,
			sequence: this.sendSequence++,
			payload: encodeControlMessage(msg),
		};
		this.ws.send(encodeFrame(frame));
	}

	private startKeepalive(): void {
		const interval = this.options.keepaliveMs ?? 30_000;
		this.keepaliveTimer = setInterval(() => {
			if (this.ws && this.state === "ready") {
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
