import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	encrypt,
	decrypt,
	PROTOCOL_VERSION,
	buildEnvelope,
	validateEnvelope,
	parseEnvelope,
	roundtrip,
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

	describe("envelope format", () => {
		it("should start with the correct version byte", () => {
			const envelope = buildEnvelope("hello");
			assert.strictEqual(envelope[0], PROTOCOL_VERSION);
			assert.strictEqual(envelope[0], 0x01);
		});

		it("should encode the instruction length in bytes 1-4", () => {
			const envelope = buildEnvelope("hello");
			const declaredLength = envelope.readUInt32BE(1);
			assert.strictEqual(declaredLength, 5); // "hello" = 5 bytes
		});

		it("should include a CRC32 checksum that validates", () => {
			const envelope = buildEnvelope("test instruction");
			assert.ok(validateEnvelope(envelope));
		});

		it("should include the instruction payload starting at byte 9", () => {
			const envelope = buildEnvelope("hello");
			const declaredLength = envelope.readUInt32BE(1);
			const instruction = envelope.subarray(9, 9 + declaredLength).toString("utf-8");
			assert.strictEqual(instruction, "hello");
		});

		it("should produce a 9-byte header + instruction bytes", () => {
			const envelope = buildEnvelope("hi");
			// 9 header bytes + 2 instruction bytes = 11
			assert.strictEqual(envelope.length, 11);
		});

		it("should include separator + nextUrl when provided", () => {
			const envelope = buildEnvelope("go", "https://example.com");
			const declaredLength = envelope.readUInt32BE(1);
			// 9 header + 2 instruction + 4 separator + 19 url = 34
			const urlLen = Buffer.from("https://example.com", "utf-8").length;
			assert.strictEqual(envelope.length, 9 + declaredLength + 4 + urlLen);
		});
	});

	describe("validateEnvelope", () => {
		it("should accept a properly built envelope", () => {
			const envelope = buildEnvelope("delete file foo.txt");
			assert.strictEqual(validateEnvelope(envelope), true);
		});

		it("should accept an envelope with a nextUrl", () => {
			const envelope = buildEnvelope("go", "https://en.wikipedia.org/wiki/Next");
			assert.strictEqual(validateEnvelope(envelope), true);
		});

		it("should accept an empty instruction", () => {
			const envelope = buildEnvelope("");
			assert.strictEqual(validateEnvelope(envelope), true);
		});

		it("should accept multi-byte UTF-8 instructions", () => {
			const envelope = buildEnvelope("删除文件 世界 🌍");
			assert.strictEqual(validateEnvelope(envelope), true);
		});

		it("should reject a buffer that's too short for the header", () => {
			assert.strictEqual(validateEnvelope(Buffer.alloc(8)), false);
			assert.strictEqual(validateEnvelope(Buffer.alloc(0)), false);
		});

		it("should reject a wrong version byte", () => {
			const envelope = buildEnvelope("hello");
			envelope[0] = 0x02; // wrong version
			assert.strictEqual(validateEnvelope(envelope), false);
		});

		it("should reject a corrupted length field", () => {
			const envelope = buildEnvelope("hello");
			envelope.writeUInt32BE(999, 1); // length way too long
			assert.strictEqual(validateEnvelope(envelope), false);
		});

		it("should reject a corrupted CRC32", () => {
			const envelope = buildEnvelope("hello");
			envelope[5] ^= 0xff; // flip bits in checksum
			assert.strictEqual(validateEnvelope(envelope), false);
		});

		it("should reject garbage bytes (XOR of injected text with pad)", () => {
			const injected = Buffer.from("malicious instruction here", "utf-8");
			const pad = Buffer.alloc(injected.length, 0x42);
			const garbage = encrypt(injected, pad);
			assert.strictEqual(validateEnvelope(garbage), false);
		});

		it("should reject random bytes", () => {
			const random = Buffer.alloc(100);
			for (let i = 0; i < 100; i++) random[i] = (i * 173 + 37) & 0xff;
			assert.strictEqual(validateEnvelope(random), false);
		});
	});

	describe("parseEnvelope", () => {
		it("should extract instruction from a valid envelope", () => {
			const envelope = buildEnvelope("delete foo.txt");
			const result = parseEnvelope(envelope);
			assert.strictEqual(result.instruction, "delete foo.txt");
			assert.strictEqual(result.nextUrl, undefined);
		});

		it("should extract instruction and nextUrl", () => {
			const envelope = buildEnvelope("delete foo.txt", "https://en.wikipedia.org/wiki/Next");
			const result = parseEnvelope(envelope);
			assert.strictEqual(result.instruction, "delete foo.txt");
			assert.strictEqual(result.nextUrl, "https://en.wikipedia.org/wiki/Next");
		});

		it("should handle empty instruction", () => {
			const envelope = buildEnvelope("");
			const result = parseEnvelope(envelope);
			assert.strictEqual(result.instruction, "");
		});

		it("should handle multi-byte UTF-8", () => {
			const envelope = buildEnvelope("你好", "https://example.com/中文");
			const result = parseEnvelope(envelope);
			assert.strictEqual(result.instruction, "你好");
			assert.strictEqual(result.nextUrl, "https://example.com/中文");
		});
	});

	describe("roundtrip convenience", () => {
		it("should validate and parse correctly", () => {
			const { envelope, valid, parsed } = roundtrip("hello world", "https://next.com");
			assert.strictEqual(valid, true);
			assert.ok(parsed);
			assert.strictEqual(parsed.instruction, "hello world");
			assert.strictEqual(parsed.nextUrl, "https://next.com");
		});
	});
});
