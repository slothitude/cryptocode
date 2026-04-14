import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PadChain } from "../src/pad-chain.js";

describe("pad-chain", () => {
	const chain = new PadChain();

	describe("encodeMessage / decodeMessage", () => {
		it("should roundtrip a simple message without nextUrl", () => {
			const encoded = chain.encodeMessage("delete file foo.txt");
			const decoded = chain.decodeMessage(encoded);

			assert.strictEqual(decoded.instruction, "delete file foo.txt");
			assert.strictEqual(decoded.nextUrl, undefined);
		});

		it("should roundtrip a message with a nextUrl", () => {
			const encoded = chain.encodeMessage(
				"delete file foo.txt",
				"https://en.wikipedia.org/wiki/Foobar",
			);
			const decoded = chain.decodeMessage(encoded);

			assert.strictEqual(decoded.instruction, "delete file foo.txt");
			assert.strictEqual(decoded.nextUrl, "https://en.wikipedia.org/wiki/Foobar");
		});

		it("should handle multi-byte UTF-8 in instruction", () => {
			const encoded = chain.encodeMessage(
				"删除文件 foo.txt",
				"https://en.wikipedia.org/wiki/中文",
			);
			const decoded = chain.decodeMessage(encoded);

			assert.strictEqual(decoded.instruction, "删除文件 foo.txt");
			assert.strictEqual(decoded.nextUrl, "https://en.wikipedia.org/wiki/中文");
		});

		it("should handle empty instruction", () => {
			const encoded = chain.encodeMessage("");
			const decoded = chain.decodeMessage(encoded);
			assert.strictEqual(decoded.instruction, "");
			assert.strictEqual(decoded.nextUrl, undefined);
		});

		it("should produce encoded output that is longer than plaintext", () => {
			const msg = "hello";
			const encodedWith = chain.encodeMessage(msg, "https://example.com");
			const encodedWithout = chain.encodeMessage(msg);

			assert.ok(encodedWith.length > encodedWithout.length);
			assert.strictEqual(encodedWithout.length, msg.length);
		});
	});
});
