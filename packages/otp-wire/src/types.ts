import type { EncryptedMessage } from "@cryptocode/otp-core";

// ── Frame types ──────────────────────────────────────────────────────

/** Wire frame type byte values. */
export enum FrameType {
	/** Encrypted user instruction (TUI → Agent). */
	USER_INSTRUCTION = 0x01,
	/** Encrypted agent streaming event (Agent → TUI). */
	AGENT_EVENT = 0x02,
	/** Plaintext JSON control message (both directions). */
	CONTROL = 0x03,
}

/** A decoded wire frame. */
export interface WireFrame {
	/** Frame type discriminator. */
	type: FrameType;
	/** Monotonically increasing sequence number (big-endian uint32). */
	sequence: number;
	/** Raw payload bytes (encrypted ciphertext for USER_INSTRUCTION/AGENT_EVENT, UTF-8 JSON for CONTROL). */
	payload: Buffer;
}

// ── Control messages ─────────────────────────────────────────────────

export interface HelloMessage {
	type: "HELLO";
	/** Protocol version. */
	version: number;
	/** Session hash for local mode verification. */
	sessionHash?: string;
}

export interface SeedExchangeMessage {
	type: "SEED_EXCHANGE";
	/** ECDH public key (hex) of the sender. */
	publicKeyHex: string;
	/** Encrypted U→A seed URL (base64). */
	encryptedSeedUA: string;
	/** Encrypted A→U seed URL (base64). */
	encryptedSeedAU: string;
}

export interface ResyncRequestMessage {
	type: "RESYNC_REQUEST";
	/** Which channel needs resync. */
	channel: "userToAgent" | "agentToUser";
	/** The recovery URL to re-fetch. */
	recoveryUrl: string;
}

export interface ResyncAckMessage {
	type: "RESYNC_ACK";
	channel: "userToAgent" | "agentToUser";
}

export interface PingMessage {
	type: "PING";
}

export interface PongMessage {
	type: "PONG";
}

export interface ErrorMessage {
	type: "ERROR";
	/** Human-readable error description. */
	message: string;
}

export interface ShutdownMessage {
	type: "SHUTDOWN";
	reason?: string;
}

/** Union of all control message types. */
export type ControlMessage =
	| HelloMessage
	| SeedExchangeMessage
	| ResyncRequestMessage
	| ResyncAckMessage
	| PingMessage
	| PongMessage
	| ErrorMessage
	| ShutdownMessage;

// ── Agent event envelope ─────────────────────────────────────────────

/**
 * Wire-serializable representation of a pi-mono AgentSessionEvent.
 * All pi-mono-specific types are flattened to JSON-safe primitives.
 */
export interface AgentEventEnvelope {
	/** Discriminator matching the pi-mono AgentSessionEvent type string. */
	eventType: string;
	/** JSON-serializable event data. */
	data: unknown;
	/** Timestamp when the event was serialized. */
	timestamp: string;
}

// ── Encrypted payload serialization ──────────────────────────────────

/**
 * Encrypted payload wire format:
 * [padBytesUsed:4B BE][padPosition:4B BE][otpSequence:4B BE][ciphertext:remaining]
 *
 * This matches the EncryptedMessage fields from otp-core.
 */

/** Wire serialization helper: convert EncryptedMessage to a Buffer. */
export type EncryptedPayloadSerializer = {
	serialize(msg: EncryptedMessage): Buffer;
	deserialize(buf: Buffer): EncryptedMessage;
};
