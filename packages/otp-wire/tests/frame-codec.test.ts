import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	encodeFrame,
	decodeFrame,
	getFrameLength,
	encodeControlMessage,
	decodeControlMessage,
	encodeEncryptedPayload,
	decodeEncryptedPayload,
} from "../src/frame-codec.js";
import { FrameType } from "../src/types.js";
import type { WireFrame, ControlMessage } from "../src/types.js";

describe("frame codec", () => {
	describe("encodeFrame / decodeFrame", () => {
		it("roundtrips a USER_INSTRUCTION frame", () => {
			const payload = Buffer.from("encrypted user message");
			const frame: WireFrame = {
				type: FrameType.USER_INSTRUCTION,
				sequence: 42,
				payload,
			};
			const encoded = encodeFrame(frame);
			const decoded = decodeFrame(encoded);
			assert.deepStrictEqual(decoded, frame);
		});

		it("roundtrips an AGENT_EVENT frame", () => {
			const payload = Buffer.from("encrypted agent event");
			const frame: WireFrame = {
				type: FrameType.AGENT_EVENT,
				sequence: 1,
				payload,
			};
			const encoded = encodeFrame(frame);
			const decoded = decodeFrame(encoded);
			assert.deepStrictEqual(decoded, frame);
		});

		it("roundtrips a CONTROL frame", () => {
			const payload = Buffer.from('{"type":"PING"}', "utf-8");
			const frame: WireFrame = {
				type: FrameType.CONTROL,
				sequence: 0,
				payload,
			};
			const encoded = encodeFrame(frame);
			const decoded = decodeFrame(encoded);
			assert.deepStrictEqual(decoded, frame);
		});

		it("returns null for buffer too short for header", () => {
			const buf = Buffer.alloc(5); // header is 9 bytes
			assert.strictEqual(decodeFrame(buf), null);
		});

		it("returns null for buffer too short for payload", () => {
			const payload = Buffer.alloc(100);
			const frame: WireFrame = {
				type: FrameType.USER_INSTRUCTION,
				sequence: 1,
				payload,
			};
			const encoded = encodeFrame(frame);
			// Truncate by 10 bytes
			const truncated = encoded.subarray(0, encoded.length - 10);
			assert.strictEqual(decodeFrame(truncated), null);
		});

		it("handles empty payload", () => {
			const frame: WireFrame = {
				type: FrameType.CONTROL,
				sequence: 0,
				payload: Buffer.alloc(0),
			};
			const encoded = encodeFrame(frame);
			const decoded = decodeFrame(encoded);
			assert.deepStrictEqual(decoded, frame);
		});

		it("handles large payload (64KB)", () => {
			const payload = Buffer.alloc(65536);
			payload.fill(0xab);
			const frame: WireFrame = {
				type: FrameType.USER_INSTRUCTION,
				sequence: 999,
				payload,
			};
			const encoded = encodeFrame(frame);
			const decoded = decodeFrame(encoded);
			assert.deepStrictEqual(decoded, frame);
		});

		it("handles max sequence number", () => {
			const frame: WireFrame = {
				type: FrameType.AGENT_EVENT,
				sequence: 0xffffffff,
				payload: Buffer.from("test"),
			};
			const encoded = encodeFrame(frame);
			const decoded = decodeFrame(encoded);
			assert.strictEqual(decoded!.sequence, 0xffffffff);
		});
	});

	describe("getFrameLength", () => {
		it("returns total frame length from header", () => {
			const payload = Buffer.alloc(50);
			const frame: WireFrame = {
				type: FrameType.USER_INSTRUCTION,
				sequence: 1,
				payload,
			};
			const encoded = encodeFrame(frame);
			// Only need the first 9 bytes (header)
			const length = getFrameLength(encoded.subarray(0, 9));
			assert.strictEqual(length, 9 + 50);
		});

		it("returns null for incomplete header", () => {
			assert.strictEqual(getFrameLength(Buffer.alloc(3)), null);
		});
	});
});

describe("control message serialization", () => {
	it("roundtrips a HELLO message", () => {
		const msg: ControlMessage = {
			type: "HELLO",
			version: 1,
			sessionHash: "abc123",
		};
		const encoded = encodeControlMessage(msg);
		const decoded = decodeControlMessage(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("roundtrips a SEED_EXCHANGE message", () => {
		const msg: ControlMessage = {
			type: "SEED_EXCHANGE",
			publicKeyHex: "deadbeef",
			encryptedSeedUA: "base64ua",
			encryptedSeedAU: "base64au",
		};
		const encoded = encodeControlMessage(msg);
		const decoded = decodeControlMessage(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("roundtrips a RESYNC_REQUEST message", () => {
		const msg: ControlMessage = {
			type: "RESYNC_REQUEST",
			channel: "userToAgent",
			recoveryUrl: "https://en.wikipedia.org/wiki/Test",
		};
		const encoded = encodeControlMessage(msg);
		const decoded = decodeControlMessage(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("roundtrips a RESYNC_ACK message", () => {
		const msg: ControlMessage = {
			type: "RESYNC_ACK",
			channel: "agentToUser",
		};
		const encoded = encodeControlMessage(msg);
		const decoded = decodeControlMessage(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("roundtrips PING/PONG", () => {
		const ping: ControlMessage = { type: "PING" };
		const pong: ControlMessage = { type: "PONG" };
		assert.deepStrictEqual(decodeControlMessage(encodeControlMessage(ping)), ping);
		assert.deepStrictEqual(decodeControlMessage(encodeControlMessage(pong)), pong);
	});

	it("roundtrips ERROR message", () => {
		const msg: ControlMessage = { type: "ERROR", message: "something went wrong" };
		const encoded = encodeControlMessage(msg);
		const decoded = decodeControlMessage(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("roundtrips SHUTDOWN message", () => {
		const msg: ControlMessage = { type: "SHUTDOWN", reason: "user requested" };
		const encoded = encodeControlMessage(msg);
		const decoded = decodeControlMessage(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("throws on invalid JSON", () => {
		const buf = Buffer.from("not json", "utf-8");
		assert.throws(() => decodeControlMessage(buf));
	});

	it("throws on missing type field", () => {
		const buf = Buffer.from('{"foo":"bar"}', "utf-8");
		assert.throws(() => decodeControlMessage(buf));
	});
});

describe("encrypted payload serialization", () => {
	it("roundtrips an EncryptedMessage", () => {
		const msg = {
			ciphertext: Buffer.from("encrypted data here"),
			padBytesUsed: 100,
			padPosition: 500,
			sequence: 7,
		};
		const encoded = encodeEncryptedPayload(msg);
		const decoded = decodeEncryptedPayload(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("roundtrips with empty ciphertext", () => {
		const msg = {
			ciphertext: Buffer.alloc(0),
			padBytesUsed: 0,
			padPosition: 0,
			sequence: 0,
		};
		const encoded = encodeEncryptedPayload(msg);
		const decoded = decodeEncryptedPayload(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("roundtrips with large ciphertext", () => {
		const ciphertext = Buffer.alloc(10000);
		ciphertext.fill(0xcd);
		const msg = {
			ciphertext,
			padBytesUsed: 10000,
			padPosition: 99999,
			sequence: 12345,
		};
		const encoded = encodeEncryptedPayload(msg);
		const decoded = decodeEncryptedPayload(encoded);
		assert.deepStrictEqual(decoded, msg);
	});

	it("throws on payload shorter than header", () => {
		const buf = Buffer.alloc(5); // header is 12 bytes
		assert.throws(() => decodeEncryptedPayload(buf));
	});

	it("handles max values", () => {
		const msg = {
			ciphertext: Buffer.from("x"),
			padBytesUsed: 0xffffffff,
			padPosition: 0xffffffff,
			sequence: 0xffffffff,
		};
		const encoded = encodeEncryptedPayload(msg);
		const decoded = decodeEncryptedPayload(encoded);
		assert.strictEqual(decoded.padBytesUsed, 0xffffffff);
		assert.strictEqual(decoded.padPosition, 0xffffffff);
		assert.strictEqual(decoded.sequence, 0xffffffff);
	});
});
