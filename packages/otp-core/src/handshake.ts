/**
 * ECDH handshake and session encryption at rest.
 *
 * Uses Node.js built-in crypto for:
 * - ECDH key pair generation (secp256k1)
 * - Shared secret derivation
 * - AES-256-GCM encryption of seed URLs and session state
 *
 * Spec Phase 0: Initial Key Exchange
 * 1. User generates ECDH keypair
 * 2. Agent generates ECDH keypair
 * 3. Both exchange public keys over the CLI channel
 * 4. Both derive the same shared secret
 * 5. Shared secret encrypts seed URLs and session.json
 */

import {
	generateKeyPairSync,
	createECDH,
	createCipheriv,
	createDecipheriv,
	randomBytes,
	createHash,
} from "node:crypto";
import type { SessionState } from "./types.js";

const CURVE = "secp256k1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/**
 * An ECDH keypair for handshake.
 */
export interface ECDHKeyPair {
	/** The PEM-encoded public key. */
	publicKeyPem: string;
	/** The PEM-encoded private key. */
	privateKeyPem: string;
}

/**
 * Result of completing the handshake.
 */
export interface HandshakeResult {
	/** The derived AES-256 key (for encrypting session state). */
	encryptionKey: Buffer;
	/** The encrypted seed URL for U→A channel. */
	encryptedSeedUA: Buffer;
	/** The encrypted seed URL for A→U channel. */
	encryptedSeedAU: Buffer;
}

/**
 * An encrypted blob (IV + authTag + ciphertext).
 */
export interface EncryptedBlob {
	iv: Buffer;
	authTag: Buffer;
	ciphertext: Buffer;
}

/**
 * Generate a new ECDH keypair (PEM-encoded).
 */
export function generateKeyPair(): ECDHKeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ec", {
		namedCurve: CURVE,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "sec1", format: "pem" },
	});

	return {
		publicKeyPem: publicKey,
		privateKeyPem: privateKey,
	};
}

/**
 * Generate an ECDH keypair and return hex-encoded keys for CLI use.
 */
export function generateKeyPairHex(): {
	publicKeyHex: string;
	privateKeyHex: string;
} {
	const ecdh = createECDH(CURVE);
	ecdh.generateKeys();

	return {
		publicKeyHex: ecdh.getPublicKey("hex"),
		privateKeyHex: ecdh.getPrivateKey("hex"),
	};
}

/**
 * Derive a shared secret from a local private key and a remote public key.
 * Returns a 32-byte AES-256 key derived from the ECDH shared secret via SHA-256.
 */
export function deriveSharedKey(
	localPrivateKeyHex: string,
	remotePublicKeyHex: string,
): Buffer {
	const ecdh = createECDH(CURVE);
	ecdh.setPrivateKey(localPrivateKeyHex, "hex");

	const sharedSecret = ecdh.computeSecret(remotePublicKeyHex, "hex");
	// Derive a fixed-length key from the shared secret
	return createHash("sha256").update(sharedSecret).digest();
}

/**
 * Encrypt a string with AES-256-GCM using the given key.
 * Returns an EncryptedBlob containing IV + authTag + ciphertext.
 */
export function encryptString(plaintext: string, key: Buffer): EncryptedBlob {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, key, iv, {
		authTagLength: AUTH_TAG_LENGTH,
	});

	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf-8"),
		cipher.final(),
	]);

	return {
		iv,
		authTag: cipher.getAuthTag(),
		ciphertext: encrypted,
	};
}

/**
 * Decrypt an EncryptedBlob with AES-256-GCM.
 * Returns the plaintext string, or throws if decryption fails (wrong key, tampered data).
 */
export function decryptBlob(blob: EncryptedBlob, key: Buffer): string {
	const decipher = createDecipheriv(ALGORITHM, key, blob.iv, {
		authTagLength: AUTH_TAG_LENGTH,
	});
	decipher.setAuthTag(blob.authTag);

	const decrypted = Buffer.concat([
		decipher.update(blob.ciphertext),
		decipher.final(),
	]);

	return decrypted.toString("utf-8");
}

/**
 * Encrypt a session state for persistence at rest.
 * The entire session JSON is encrypted with AES-256-GCM.
 */
export function encryptSessionState(
	state: SessionState,
	key: Buffer,
): Buffer {
	const json = JSON.stringify(state);
	const blob = encryptString(json, key);
	// Serialize: [ivLength:1B][iv:16B][authTagLength:1B][authTag:16B][ciphertext:NB]
	return Buffer.concat([
		Buffer.from([blob.iv.length]),
		blob.iv,
		Buffer.from([blob.authTag.length]),
		blob.authTag,
		blob.ciphertext,
	]);
}

/**
 * Decrypt a session state from its encrypted binary form.
 */
export function decryptSessionState(encrypted: Buffer, key: Buffer): SessionState {
	let offset = 0;

	const ivLen = encrypted[offset];
	offset += 1;
	const iv = encrypted.subarray(offset, offset + ivLen);
	offset += ivLen;

	const tagLen = encrypted[offset];
	offset += 1;
	const authTag = encrypted.subarray(offset, offset + tagLen);
	offset += tagLen;

	const ciphertext = encrypted.subarray(offset);

	const json = decryptBlob({ iv, authTag, ciphertext }, key);
	return JSON.parse(json) as SessionState;
}

/**
 * Encrypt a seed URL for transmission.
 */
export function encryptSeedUrl(url: string, key: Buffer): string {
	const blob = encryptString(url, key);
	// Base64 encode for easy transport
	return Buffer.concat([
		Buffer.from([blob.iv.length]),
		blob.iv,
		Buffer.from([blob.authTag.length]),
		blob.authTag,
		blob.ciphertext,
	]).toString("base64");
}

/**
 * Decrypt a seed URL from its base64-encoded encrypted form.
 */
export function decryptSeedUrl(encoded: string, key: Buffer): string {
	const data = Buffer.from(encoded, "base64");
	let offset = 0;

	const ivLen = data[offset];
	offset += 1;
	const iv = data.subarray(offset, offset + ivLen);
	offset += ivLen;

	const tagLen = data[offset];
	offset += 1;
	const authTag = data.subarray(offset, offset + tagLen);
	offset += tagLen;

	const ciphertext = data.subarray(offset);

	return decryptBlob({ iv, authTag, ciphertext }, key);
}
