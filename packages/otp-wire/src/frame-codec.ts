import type { EncryptedMessage } from "@cryptocode/otp-core";
import { FrameType } from "./types.js";
import type { WireFrame, ControlMessage } from "./types.js";

// ── Wire frame format ────────────────────────────────────────────────
// [type:1B][sequence:4B BE][length:4B BE][payload:NB]

const HEADER_SIZE = 1 + 4 + 4; // type + sequence + length

/**
 * Encode a wire frame into a binary buffer.
 */
export function encodeFrame(frame: WireFrame): Buffer {
	const header = Buffer.alloc(HEADER_SIZE);
	header.writeUInt8(frame.type, 0);
	header.writeUInt32BE(frame.sequence, 1);
	header.writeUInt32BE(frame.payload.length, 5);
	return Buffer.concat([header, frame.payload]);
}

/**
 * Decode a wire frame from a binary buffer.
 * Returns null if the buffer is too short to contain a complete frame.
 */
export function decodeFrame(buf: Buffer): WireFrame | null {
	if (buf.length < HEADER_SIZE) return null;

	const type = buf.readUInt8(0) as FrameType;
	const sequence = buf.readUInt32BE(1);
	const length = buf.readUInt32BE(5);

	if (buf.length < HEADER_SIZE + length) return null;

	const payload = Buffer.from(buf.subarray(HEADER_SIZE, HEADER_SIZE + length));
	return { type, sequence, payload };
}

/**
 * Get the total byte length of a frame from its header.
 * Returns null if the buffer doesn't contain a full header.
 */
export function getFrameLength(buf: Buffer): number | null {
	if (buf.length < HEADER_SIZE) return null;
	const payloadLength = buf.readUInt32BE(5);
	return HEADER_SIZE + payloadLength;
}

// ── Control message serialization ────────────────────────────────────

/**
 * Encode a control message into a UTF-8 JSON buffer.
 */
export function encodeControlMessage(msg: ControlMessage): Buffer {
	return Buffer.from(JSON.stringify(msg), "utf-8");
}

/**
 * Decode a control message from a UTF-8 JSON buffer.
 * Throws on invalid JSON or unrecognized type.
 */
export function decodeControlMessage(buf: Buffer): ControlMessage {
	const text = buf.toString("utf-8");
	const parsed = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
		throw new Error(`Invalid control message: missing "type" field`);
	}
	return parsed as ControlMessage;
}

// ── Encrypted payload serialization ──────────────────────────────────
// [padBytesUsed:4B BE][padPosition:4B BE][otpSequence:4B BE][ciphertext:remaining]

const PAYLOAD_HEADER_SIZE = 4 + 4 + 4;

/**
 * Serialize an EncryptedMessage into a binary payload for wire transport.
 */
export function encodeEncryptedPayload(msg: EncryptedMessage): Buffer {
	const header = Buffer.alloc(PAYLOAD_HEADER_SIZE);
	header.writeUInt32BE(msg.padBytesUsed, 0);
	header.writeUInt32BE(msg.padPosition, 4);
	header.writeUInt32BE(msg.sequence, 8);
	return Buffer.concat([header, msg.ciphertext]);
}

/**
 * Deserialize a binary payload back into an EncryptedMessage.
 */
export function decodeEncryptedPayload(buf: Buffer): EncryptedMessage {
	if (buf.length < PAYLOAD_HEADER_SIZE) {
		throw new Error(`Payload too short: ${buf.length} bytes, need at least ${PAYLOAD_HEADER_SIZE}`);
	}
	const padBytesUsed = buf.readUInt32BE(0);
	const padPosition = buf.readUInt32BE(4);
	const sequence = buf.readUInt32BE(8);
	const ciphertext = Buffer.from(buf.subarray(PAYLOAD_HEADER_SIZE));
	return { ciphertext, padBytesUsed, padPosition, sequence };
}
