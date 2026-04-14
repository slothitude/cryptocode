import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PadManager } from "../src/pad-manager.js";
import { PadChain } from "../src/pad-chain.js";
import { encrypt, decrypt, validateEnvelope, parseEnvelope } from "../src/otp-cipher.js";

describe("chain transition under load", () => {
	describe("rapid message sequence", () => {
		it("should maintain position counter correctly across many messages", async () => {
			const buf = Buffer.alloc(100_000);
			for (let i = 0; i < 100_000; i++) buf[i] = (i * 37 + 17) & 0xff;
			const sender = new PadManager("test://big", buf);
			const receiver = new PadManager("test://big", Buffer.from(buf));

			let senderPos = 0;
			let receiverPos = 0;
			const chain = new PadChain();

			for (let i = 0; i < 50; i++) {
				const instruction = `message number ${i}`;
				const envelope = chain.encodeMessage(instruction);
				const pad = await sender.advance(envelope.length);
				const ciphertext = encrypt(envelope, pad);
				senderPos += envelope.length;

				// Decrypt on receiver side
				const recvPad = await receiver.advance(envelope.length);
				const raw = decrypt(ciphertext, recvPad);
				receiverPos += envelope.length;

				assert.ok(validateEnvelope(raw), `Message ${i} should validate`);

				const decoded = parseEnvelope(raw);
				assert.strictEqual(decoded.instruction, instruction, `Message ${i} instruction should match`);
			}

			assert.strictEqual(sender.getPosition(), senderPos);
			assert.strictEqual(receiver.getPosition(), receiverPos);
			assert.strictEqual(sender.getPosition(), receiver.getPosition(), "Positions should match");
		});

		it("should handle messages with embedded nextUrl across sequence", async () => {
			const buf = Buffer.alloc(50_000);
			for (let i = 0; i < 50_000; i++) buf[i] = (i * 73 + 41) & 0xff;
			const chain = new PadChain();

			const urls = [
				"https://en.wikipedia.org/wiki/Page1",
				"https://en.wikipedia.org/wiki/Page2",
				"https://en.wikipedia.org/wiki/Page3",
			];

			for (let i = 0; i < urls.length; i++) {
				const instruction = `transition ${i}`;
				const nextUrl = i < urls.length - 1 ? urls[i + 1] : undefined;

				const envelope = chain.encodeMessage(instruction, nextUrl);
				const sender = new PadManager("test://chain", buf);
				const pad = await sender.advance(envelope.length);

				const raw = decrypt(encrypt(envelope, pad), pad);
				assert.ok(validateEnvelope(raw));

				const decoded = parseEnvelope(raw);
				assert.strictEqual(decoded.instruction, instruction);

				if (nextUrl) {
					assert.strictEqual(decoded.nextUrl, nextUrl, `Chain ${i} should have correct nextUrl`);
				} else {
					assert.strictEqual(decoded.nextUrl, undefined, "Last message should have no nextUrl");
				}
			}
		});

		it("should handle varying message sizes without position drift", async () => {
			const buf = Buffer.alloc(100_000);
			for (let i = 0; i < 100_000; i++) buf[i] = (i * 97 + 23) & 0xff;
			const sender = new PadManager("test://varsize", buf);
			const receiver = new PadManager("test://varsize", Buffer.from(buf));

			const sizes = [5, 100, 1, 500, 20, 3, 1000, 7, 250, 50];
			let totalConsumed = 0;

			for (let i = 0; i < sizes.length; i++) {
				const instruction = "x".repeat(sizes[i]);
				const envelope = Buffer.concat([
					Buffer.from([0x01]),
					Buffer.alloc(4), // length placeholder
					Buffer.alloc(4), // checksum placeholder
					Buffer.from(instruction, "utf-8"),
				]);
				// Build proper envelope
				const chain = new PadChain();
				const properEnvelope = chain.encodeMessage(instruction);

				const pad = await sender.advance(properEnvelope.length);
				const ciphertext = encrypt(properEnvelope, pad);
				totalConsumed += properEnvelope.length;

				const recvPad = await receiver.advance(properEnvelope.length);
				const raw = decrypt(ciphertext, recvPad);

				assert.ok(validateEnvelope(raw), `Message ${i} (size ${sizes[i]}) should validate`);
			}

			assert.strictEqual(sender.getPosition(), receiver.getPosition());
			assert.strictEqual(sender.getPosition(), totalConsumed);
			assert.strictEqual(sender.getSequence(), sizes.length);
			assert.strictEqual(receiver.getSequence(), sizes.length);
		});
	});

	describe("pad exhaustion at boundary", () => {
		it("should exhaust exactly at buffer end without skipping", async () => {
			const buf = Buffer.alloc(1000);
			const pm = new PadManager("test://exact", buf);

			await pm.advance(600);
			await pm.advance(400);

			assert.strictEqual(pm.getPosition(), 1000);
			assert.strictEqual(pm.getRemaining(), 0);

			await assert.rejects(() => pm.advance(1), /Pad exhausted/);
		});

		it("should track sequence through pad exhaustion", async () => {
			const buf = Buffer.alloc(1000);
			const pm = new PadManager("test://seq", buf);

			assert.strictEqual(pm.getSequence(), 0);
			await pm.advance(100);
			assert.strictEqual(pm.getSequence(), 1);
			await pm.advance(200);
			assert.strictEqual(pm.getSequence(), 2);
			await pm.advance(700);
			assert.strictEqual(pm.getSequence(), 3);
		});
	});

	describe("discardUsed with sequence tracking", () => {
		it("should preserve sequence number after discardUsed", async () => {
			const buf = Buffer.alloc(2_000_000);
			const pm = new PadManager("test://big", buf);

			await pm.advance(1_048_577);
			assert.strictEqual(pm.getPosition(), 0); // Discard resets position
			assert.strictEqual(pm.getSequence(), 1); // But sequence is preserved
		});

		it("should serialize sequence in ChannelState", async () => {
			const buf = Buffer.alloc(100);
			const pm = new PadManager("test://state", buf);

			await pm.advance(10);
			await pm.advance(20);
			const state = pm.toState();

			assert.strictEqual(state.sequence, 2);
		});
	});
});
