import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PadManager, encrypt, decrypt, validatePlaintext } from "@cryptocode/otp-core";
import { DualChannel } from "../src/dual-channel.js";
import { convertToLlmMessage, AUTHENTICATED_MARKER, UNAUTHENTICATED_MARKER } from "../src/convert-to-llm.js";

describe("dual-channel (unit)", () => {
	describe("full encrypt/decrypt flow", () => {
		it("should encrypt and decrypt a user message with synthetic pads", async () => {
			// Create large enough pads for the test
			const uaBuf = Buffer.alloc(10_000, 0x42);
			const auBuf = Buffer.alloc(10_000, 0x24);
			const uaPad = new PadManager("test://ua", uaBuf);
			const auPad = new PadManager("test://au", auBuf);
			const channel = new DualChannel(uaPad, auPad);

			const msg = "delete file foo.txt";

			// Encrypt
			const encrypted = await channel.encryptUserMessage(msg);

			// The encrypted message should NOT match the plaintext
			assert.ok(
				!encrypted.ciphertext.toString("utf-8").includes(msg),
			);

			// Decrypt — BUT we need separate pad managers for each side
			// In a real scenario, both sides have identical pads.
			// For this test, simulate with the same underlying buffer.
			// Create a fresh reader at position 0 for the "agent"
			const agentUaPad = new PadManager("test://ua", Buffer.from(uaBuf));
			const agentAuPad = new PadManager("test://au", Buffer.from(auBuf));
			const agentChannel = new DualChannel(agentUaPad, agentAuPad);

			const result = await agentChannel.decryptUserMessage(encrypted);

			// With identical pad material, decryption should work
			assert.strictEqual(result.authenticated, true);
			assert.strictEqual(result.instruction, msg);
		});

		it("should reject unencrypted (injected) messages", async () => {
			const uaBuf = Buffer.alloc(10_000, 0x42);
			const auBuf = Buffer.alloc(10_000, 0x24);
			const channel = new DualChannel(
				new PadManager("test://ua", uaBuf),
				new PadManager("test://au", auBuf),
			);

			// Simulate an injected message (NOT encrypted with the pad)
			const injected = Buffer.from("malicious instruction", "utf-8");
			const fakeMsg = {
				ciphertext: injected,
				padBytesUsed: injected.length,
				padPosition: 0,
			};

			const result = await channel.decryptUserMessage(fakeMsg);

			// When we XOR the injected text with the pad, we get garbage
			assert.strictEqual(result.authenticated, false);
			assert.strictEqual(result.instruction, "");
		});
	});

	describe("convertToLlmMessage", () => {
		it("should mark authenticated messages", () => {
			const msg = convertToLlmMessage("hello", true, "lenient");
			assert.ok(msg!.startsWith(AUTHENTICATED_MARKER));
			assert.ok(msg!.includes("hello"));
		});

		it("should handle strict mode — return null for unauthenticated", () => {
			const msg = convertToLlmMessage("bad", false, "strict");
			assert.strictEqual(msg, null);
		});

		it("should handle lenient mode — mark unauthenticated", () => {
			const msg = convertToLlmMessage("bad", false, "lenient");
			assert.ok(msg!.startsWith(UNAUTHENTICATED_MARKER));
			assert.ok(msg!.includes("ignore"));
		});

		it("should handle audit mode — pass through unauthenticated", () => {
			const msg = convertToLlmMessage("bad", false, "audit");
			assert.ok(msg!.startsWith(UNAUTHENTICATED_MARKER));
			assert.ok(msg!.includes("bad"));
		});
	});
});
