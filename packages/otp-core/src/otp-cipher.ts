/**
 * XOR-based one-time pad cipher.
 *
 * Encryption and decryption are identical operations: XOR the plaintext/ciphertext
 * with the pad bytes. This is the information-theoretic security guarantee —
 * without the pad, the ciphertext reveals zero information about the plaintext.
 */

/** Magic prefix for authenticated messages. */
const AUTH_PREFIX = Buffer.from("\x00CRYP", "utf-8");

/** XOR plaintext with pad bytes. Returns ciphertext. */
export function encrypt(plaintext: Buffer, pad: Buffer): Buffer {
	if (pad.length < plaintext.length) {
		throw new Error(
			`Pad too short: need ${plaintext.length} bytes, have ${pad.length}`,
		);
	}
	const result = Buffer.alloc(plaintext.length);
	for (let i = 0; i < plaintext.length; i++) {
		result[i] = plaintext[i] ^ pad[i];
	}
	return result;
}

/** XOR ciphertext with pad bytes. Returns plaintext. (Symmetric with encrypt.) */
export function decrypt(ciphertext: Buffer, pad: Buffer): Buffer {
	return encrypt(ciphertext, pad);
}

/**
 * Prepare a plaintext buffer by prepending the authentication prefix.
 * This ensures that only messages encrypted with the correct pad will
 * validate — the prefix XORed with the wrong pad produces detectable garbage.
 */
export function preparePlaintext(instruction: string): Buffer {
	const payload = Buffer.from(instruction, "utf-8");
	return Buffer.concat([AUTH_PREFIX, payload]);
}

/**
 * Extract the instruction from a prepared plaintext buffer.
 * Returns null if the auth prefix is not present.
 */
export function extractPlaintext(data: Buffer): string | null {
	if (data.length < AUTH_PREFIX.length) return null;
	const prefix = data.subarray(0, AUTH_PREFIX.length);
	if (!prefix.equals(AUTH_PREFIX)) return null;
	return data.subarray(AUTH_PREFIX.length).toString("utf-8");
}

/**
 * Validate that a decrypted buffer represents a legitimate instruction.
 * Checks for the authentication prefix and valid UTF-8 payload.
 */
export function validatePlaintext(data: Buffer): boolean {
	if (data.length < AUTH_PREFIX.length) return false;

	const prefix = data.subarray(0, AUTH_PREFIX.length);
	if (!prefix.equals(AUTH_PREFIX)) return false;

	// Remaining bytes must be valid UTF-8
	const payload = data.subarray(AUTH_PREFIX.length);
	try {
		const text = payload.toString("utf-8");
		if (text.includes("\uFFFD")) return false;
		return true;
	} catch {
		return false;
	}
}
