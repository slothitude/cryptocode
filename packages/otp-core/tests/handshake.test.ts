import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	generateKeyPair,
	generateKeyPairHex,
	deriveSharedKey,
	encryptString,
	decryptBlob,
	encryptSessionState,
	decryptSessionState,
	encryptSeedUrl,
	decryptSeedUrl,
} from "../src/handshake.js";
import type { SessionState } from "../src/types.js";

describe("ECDH handshake", () => {
	describe("generateKeyPairHex", () => {
		it("should return hex-encoded public and private keys", () => {
			const keys = generateKeyPairHex();
			assert.ok(keys.publicKeyHex, "Should have publicKeyHex");
			assert.ok(keys.privateKeyHex, "Should have privateKeyHex");
			// secp256k1 uncompressed public key is 65 bytes = 130 hex chars
			assert.strictEqual(keys.publicKeyHex.length, 130);
			// Private key is 32 bytes = 64 hex chars
			assert.strictEqual(keys.privateKeyHex.length, 64);
		});

		it("should generate unique keypairs each time", () => {
			const a = generateKeyPairHex();
			const b = generateKeyPairHex();
			assert.notStrictEqual(a.publicKeyHex, b.publicKeyHex);
			assert.notStrictEqual(a.privateKeyHex, b.privateKeyHex);
		});
	});

	describe("generateKeyPair", () => {
		it("should return PEM-encoded keys", () => {
			const keys = generateKeyPair();
			assert.ok(keys.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"));
			assert.ok(keys.publicKeyPem.endsWith("-----END PUBLIC KEY-----\n"));
			assert.ok(keys.privateKeyPem.includes("-----BEGIN EC PRIVATE KEY-----"));
			assert.ok(keys.privateKeyPem.includes("-----END EC PRIVATE KEY-----"));
		});
	});

	describe("deriveSharedKey", () => {
		it("should derive the same shared key from either side", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();

			const aliceShared = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);
			const bobShared = deriveSharedKey(bob.privateKeyHex, alice.publicKeyHex);

			assert.deepStrictEqual(aliceShared, bobShared);
		});

		it("should produce a 32-byte key", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const shared = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);
			assert.strictEqual(shared.length, 32);
		});

		it("should fail with wrong public key", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const eve = generateKeyPairHex();

			const sharedAB = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);
			const sharedAE = deriveSharedKey(alice.privateKeyHex, eve.publicKeyHex);

			assert.notDeepStrictEqual(sharedAB, sharedAE);
		});
	});

	describe("encryptString / decryptBlob", () => {
		it("should roundtrip a string", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const key = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);

			const plaintext = "Hello, Cryptocode!";
			const blob = encryptString(plaintext, key);
			const recovered = decryptBlob(blob, key);

			assert.strictEqual(recovered, plaintext);
		});

		it("should use different IVs each time", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const key = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);

			const a = encryptString("same", key);
			const b = encryptString("same", key);

			// IVs should differ (random)
			assert.notDeepStrictEqual(a.iv, b.iv);
			// Ciphertext also differs because IV differs
			assert.notDeepStrictEqual(a.ciphertext, b.ciphertext);
			// But both decrypt to the same plaintext
			assert.strictEqual(decryptBlob(a, key), "same");
			assert.strictEqual(decryptBlob(b, key), "same");
		});

		it("should fail to decrypt with wrong key", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const eve = generateKeyPairHex();

			const keyAB = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);
			const keyAE = deriveSharedKey(alice.privateKeyHex, eve.publicKeyHex);

			const blob = encryptString("secret", keyAB);

			assert.throws(() => decryptBlob(blob, keyAE));
		});

		it("should handle empty string", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const key = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);

			const blob = encryptString("", key);
			const recovered = decryptBlob(blob, key);
			assert.strictEqual(recovered, "");
		});

		it("should handle unicode", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const key = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);

			const plaintext = "🔐 暗号 🚀 العربية";
			const blob = encryptString(plaintext, key);
			const recovered = decryptBlob(blob, key);
			assert.strictEqual(recovered, plaintext);
		});
	});

	describe("encryptSessionState / decryptSessionState", () => {
		it("should roundtrip session state", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const key = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);

			const state: SessionState = {
				version: 1,
				channels: {
					userToAgent: {
						seedUrl: "https://en.wikipedia.org/wiki/Cryptography",
						position: 12345,
						currentUrl: "https://en.wikipedia.org/wiki/RSA_(cryptosystem)",
						bufferHash: "abc123",
						lowWaterMark: 10240,
						sequence: 5,
						lastSuccessfulUrl: "https://en.wikipedia.org/wiki/Cipher",
					},
					agentToUser: {
						seedUrl: "https://en.wikipedia.org/wiki/One-time_pad",
						position: 6789,
						currentUrl: "https://en.wikipedia.org/wiki/Venona_project",
						bufferHash: "def456",
						lowWaterMark: 10240,
						sequence: 3,
						lastSuccessfulUrl: "https://en.wikipedia.org/wiki/Encryption",
					},
				},
				createdAt: "2026-04-14T10:00:00Z",
			};

			const encrypted = encryptSessionState(state, key);
			assert.ok(Buffer.isBuffer(encrypted));
			assert.ok(encrypted.length > 0);

			const decrypted = decryptSessionState(encrypted, key);
			assert.deepStrictEqual(decrypted, state);
		});

		it("should fail to decrypt with wrong key", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const eve = generateKeyPairHex();

			const keyAB = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);
			const keyAE = deriveSharedKey(alice.privateKeyHex, eve.publicKeyHex);

			const state: SessionState = {
				version: 1,
				channels: {
					userToAgent: {
						seedUrl: "https://example.com/ua",
						position: 0,
						currentUrl: "https://example.com/ua",
						bufferHash: "",
						lowWaterMark: 10240,
						sequence: 0,
						lastSuccessfulUrl: "https://example.com/ua",
					},
					agentToUser: {
						seedUrl: "https://example.com/au",
						position: 0,
						currentUrl: "https://example.com/au",
						bufferHash: "",
						lowWaterMark: 10240,
						sequence: 0,
						lastSuccessfulUrl: "https://example.com/au",
					},
				},
				createdAt: "2026-04-14T10:00:00Z",
			};

			const encrypted = encryptSessionState(state, keyAB);
			assert.throws(() => decryptSessionState(encrypted, keyAE));
		});

		it("should produce different ciphertext for same plaintext (random IV)", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const key = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);

			const state: SessionState = {
				version: 1,
				channels: {
					userToAgent: {
						seedUrl: "https://example.com",
						position: 0,
						currentUrl: "https://example.com",
						bufferHash: "",
						lowWaterMark: 10240,
						sequence: 0,
						lastSuccessfulUrl: "https://example.com",
					},
					agentToUser: {
						seedUrl: "https://example.com",
						position: 0,
						currentUrl: "https://example.com",
						bufferHash: "",
						lowWaterMark: 10240,
						sequence: 0,
						lastSuccessfulUrl: "https://example.com",
					},
				},
				createdAt: "2026-04-14T10:00:00Z",
			};

			const enc1 = encryptSessionState(state, key);
			const enc2 = encryptSessionState(state, key);

			// Different IVs → different ciphertext
			assert.notDeepStrictEqual(enc1, enc2);

			// Both decrypt to same state
			assert.deepStrictEqual(decryptSessionState(enc1, key), state);
			assert.deepStrictEqual(decryptSessionState(enc2, key), state);
		});
	});

	describe("encryptSeedUrl / decryptSeedUrl", () => {
		it("should roundtrip a seed URL", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const key = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);

			const url = "https://en.wikipedia.org/wiki/Cryptography";
			const encrypted = encryptSeedUrl(url, key);
			const decrypted = decryptSeedUrl(encrypted, key);

			assert.strictEqual(decrypted, url);
		});

		it("should produce base64 output", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const key = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);

			const encrypted = encryptSeedUrl("https://example.com", key);
			assert.ok(typeof encrypted === "string");
			// Valid base64
			assert.ok(Buffer.from(encrypted, "base64").toString("base64") === encrypted);
		});

		it("should fail with wrong key", () => {
			const alice = generateKeyPairHex();
			const bob = generateKeyPairHex();
			const eve = generateKeyPairHex();

			const keyAB = deriveSharedKey(alice.privateKeyHex, bob.publicKeyHex);
			const keyAE = deriveSharedKey(alice.privateKeyHex, eve.publicKeyHex);

			const encrypted = encryptSeedUrl("https://secret.com", keyAB);
			assert.throws(() => decryptSeedUrl(encrypted, keyAE));
		});
	});
});
