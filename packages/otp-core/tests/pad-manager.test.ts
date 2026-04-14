import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PadManager } from "../src/pad-manager.js";

describe("pad-manager", () => {
	describe("with synthetic buffer", () => {
		it("should advance position and return correct bytes", async () => {
			const buf = Buffer.alloc(100, 0x42);
			const pm = new PadManager("test://fake", buf);

			const slice = await pm.advance(10);
			assert.strictEqual(slice.length, 10);
			assert.strictEqual(pm.getPosition(), 10);
			assert.strictEqual(pm.getRemaining(), 90);
		});

		it("should return sequential slices", async () => {
			const buf = Buffer.alloc(100);
			for (let i = 0; i < 100; i++) buf[i] = i;

			const pm = new PadManager("test://fake", buf);

			const s1 = await pm.advance(10);
			const s2 = await pm.advance(10);

			assert.strictEqual(s1[0], 0);
			assert.strictEqual(s1[9], 9);
			assert.strictEqual(s2[0], 10);
			assert.strictEqual(s2[9], 19);
		});

		it("should throw when pad is exhausted", async () => {
			const buf = Buffer.alloc(10);
			const pm = new PadManager("test://fake", buf);

			await assert.rejects(() => pm.advance(20), /Pad exhausted/);
		});

		it("should discard used bytes and reset position", async () => {
			const buf = Buffer.alloc(100);
			const pm = new PadManager("test://fake", buf);

			await pm.advance(50);
			assert.strictEqual(pm.getPosition(), 50);

			pm.discardUsed();
			assert.strictEqual(pm.getPosition(), 0);
			assert.strictEqual(pm.getRemaining(), 50);
		});

		it("should compute correct buffer hash", async () => {
			const buf = Buffer.alloc(100, 0xab);
			const pm = new PadManager("test://fake", buf);

			await pm.advance(10);
			const hash = pm.getBufferHash();

			assert.strictEqual(hash.length, 64); // SHA-256 hex
			assert.ok(/^[0-9a-f]{64}$/.test(hash));
		});

		it("should serialize to ChannelState", async () => {
			const buf = Buffer.alloc(100);
			const pm = new PadManager("test://fake", buf, 0, 2048);

			await pm.advance(10);
			const state = pm.toState();

			assert.strictEqual(state.seedUrl, "test://fake");
			assert.strictEqual(state.position, 0); // discardUsed resets position
			assert.strictEqual(state.lowWaterMark, 2048);
			assert.ok(state.bufferHash);
		});
	});
});
