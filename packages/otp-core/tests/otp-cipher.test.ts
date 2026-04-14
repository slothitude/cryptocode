import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	encrypt,
	decrypt,
	validatePlaintext,
	preparePlaintext,
	extractPlaintext,
} from "../src/otp-cipher.js";

describe("otp-cipher", () => {
	describe("encrypt/decrypt roundtrip", () => {
		it("should perfectly roundtrip a short message", () => {
			const plaintext = Buffer.from("Hello, World!", "utf-8");
			const pad = Buffer.from(
				"abcdefghijklmnopqrstuvwxyz012345",
				"utf-8",
			);

			const ciphertext = encrypt(plaintext, pad);
			const recovered = decrypt(ciphertext, pad);

			assert.deepStrictEqual(recovered, plaintext);
			assert.strictEqual(recovered.toString("utf-8"), "Hello, World!");
		});

		it("should produce different ciphertext for different pads", () => {
			const plaintext = Buffer.from("same message", "utf-8");
			const pad1 = Buffer.alloc(plaintext.length, 0x42);
			const pad2 = Buffer.alloc(plaintext.length, 0x24);

			const ct1 = encrypt(plaintext, pad1);
			const ct2 = encrypt(plaintext, pad2);

			assert.notDeepStrictEqual(ct1, ct2);
		});

		it("should produce ciphertext different from plaintext", () => {
			const plaintext = Buffer.from("aaaaaaaaaaaa", "utf-8");
			const pad = Buffer.alloc(plaintext.length, 0xff);

			const ct = encrypt(plaintext, pad);

			assert.notDeepStrictEqual(ct, plaintext);
		});

		it("should throw if pad is shorter than plaintext", () => {
			const plaintext = Buffer.alloc(100);
			const pad = Buffer.alloc(50);

			assert.throws(() => encrypt(plaintext, pad), /Pad too short/);
		});

		it("should handle empty plaintext", () => {
			const plaintext = Buffer.alloc(0);
			const pad = Buffer.alloc(10);

			const ct = encrypt(plaintext, pad);
			assert.strictEqual(ct.length, 0);
		});

		it("should handle binary data", () => {
			const data = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f]);
			const pad = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);

			const ct = encrypt(data, pad);
			const recovered = decrypt(ct, pad);

			assert.deepStrictEqual(recovered, data);
		});

		it("should handle large messages", () => {
			const plaintext = Buffer.alloc(100_000, 0x41);
			const pad = Buffer.alloc(100_000, 0x55);

			const ct = encrypt(plaintext, pad);
			const recovered = decrypt(ct, pad);

			assert.deepStrictEqual(recovered, plaintext);
		});
	});

	describe("preparePlaintext / extractPlaintext", () => {
		it("should prepend auth prefix and extract it back", () => {
			const prepared = preparePlaintext("delete file foo.txt");
			const extracted = extractPlaintext(prepared);
			assert.strictEqual(extracted, "delete file foo.txt");
		});

		it("should return null for buffer without auth prefix", () => {
			const buf = Buffer.from("no prefix here", "utf-8");
			assert.strictEqual(extractPlaintext(buf), null);
		});

		it("should handle empty instruction", () => {
			const prepared = preparePlaintext("");
			const extracted = extractPlaintext(prepared);
			assert.strictEqual(extracted, "");
		});
	});

	describe("validatePlaintext", () => {
		it("should accept properly prepared plaintext", () => {
			const prepared = preparePlaintext("Hello, World!");
			assert.strictEqual(validatePlaintext(prepared), true);
		});

		it("should reject empty buffer", () => {
			assert.strictEqual(validatePlaintext(Buffer.alloc(0)), false);
		});

		it("should reject buffer without auth prefix", () => {
			const buf = Buffer.from("no auth prefix", "utf-8");
			assert.strictEqual(validatePlaintext(buf), false);
		});

		it("should reject buffer that's too short for prefix", () => {
			assert.strictEqual(validatePlaintext(Buffer.from([0x00])), false);
		});

		it("should reject garbage bytes (XOR of injected text with pad)", () => {
			// Simulate what happens when an injected string is XORed with the pad
			// The injected string does NOT have the auth prefix prepended,
			// so XORing it with the pad produces garbage without the prefix.
			const injected = Buffer.from("malicious instruction", "utf-8");
			const pad = Buffer.alloc(injected.length, 0x42);
			const garbage = encrypt(injected, pad);

			// This garbage is what the agent would see when trying to decrypt
			// an unencrypted injection attempt — it won't have the auth prefix
			assert.strictEqual(validatePlaintext(garbage), false);
		});

		it("should reject even ASCII text that lacks the prefix", () => {
			const plain = Buffer.from("hello world", "utf-8");
			assert.strictEqual(validatePlaintext(plain), false);
		});
	});
});
