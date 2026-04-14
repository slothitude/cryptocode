/**
 * XOR-based one-time pad cipher with spec-compliant envelope format.
 *
 * Envelope layout (Section 5 of spec):
 *   [version: 1B][length: 4B][CRC32: 4B][instruction: NB][separator: 4B][nextUrl: MB]
 *
 * The envelope wraps the pad-chain payload (instruction + optional next URL).
 * Validation checks version byte, length field consistency, CRC32 integrity,
 * and UTF-8 well-formedness. Injected text XORed with the pad produces garbage
 * that fails at the version byte with overwhelming probability.
 */

/** Protocol version byte. */
export const PROTOCOL_VERSION = 0x01;

/** Fixed separator between instruction and next URL. 4 bytes per spec. */
const SEPARATOR = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

/**
 * Pure-JS CRC32 using the standard polynomial (0xEDB88320).
 * No dependency on node:zlib — works on Node 18+.
 */
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let c = i;
	for (let j = 0; j < 8; j++) {
		c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	}
	CRC32_TABLE[i] = c;
}
function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xff];
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** Byte offset of each envelope field. */
const OFFSET_VERSION = 0;
const OFFSET_LENGTH = 1;
const OFFSET_CHECKSUM = 5;
const OFFSET_INSTRUCTION = 9;
const HEADER_SIZE = OFFSET_INSTRUCTION; // 9 bytes

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
 * Compute CRC32 of a buffer, returned as a 4-byte big-endian Buffer.
 */
function computeCrc32(data: Buffer): Buffer {
	const checksum = crc32(data);
	const buf = Buffer.alloc(4);
	buf.writeUInt32BE(checksum >>> 0, 0);
	return buf;
}

/**
 * Build the full envelope: encode instruction + optional nextUrl into
 * the spec envelope format with version, length, CRC32, instruction,
 * separator, and optional next URL.
 */
export function buildEnvelope(instruction: string, nextUrl?: string): Buffer {
	const instructionBuf = Buffer.from(instruction, "utf-8");

	// Payload = instruction + optional separator + nextUrl
	let payload: Buffer;
	if (nextUrl) {
		const urlBuf = Buffer.from(nextUrl, "utf-8");
		payload = Buffer.concat([instructionBuf, SEPARATOR, urlBuf]);
	} else {
		payload = instructionBuf;
	}

	// Length field = byte length of instruction (not payload)
	const lengthBuf = Buffer.alloc(4);
	lengthBuf.writeUInt32BE(instructionBuf.length, 0);

	// CRC32 over the payload bytes
	const checksumBuf = computeCrc32(payload);

	// Full envelope
	return Buffer.concat([
		Buffer.from([PROTOCOL_VERSION]), // 1 byte
		lengthBuf,                        // 4 bytes
		checksumBuf,                      // 4 bytes
		payload,                          // N bytes (instruction + opt separator + url)
	]);
}

/** Result of envelope parsing. */
export interface EnvelopeParseResult {
	instruction: string;
	nextUrl?: string;
}

/**
 * Validate a decrypted buffer against the envelope format.
 * Returns true if the buffer has a valid version, consistent length,
 * matching CRC32, and well-formed UTF-8 instruction.
 */
export function validateEnvelope(data: Buffer): boolean {
	if (data.length < HEADER_SIZE) return false;

	// Version byte
	const version = data[OFFSET_VERSION];
	if (version !== PROTOCOL_VERSION) return false;

	// Length field
	const declaredLength = data.readUInt32BE(OFFSET_LENGTH);

	// Instruction starts at offset 9
	const payloadStart = OFFSET_INSTRUCTION;
	const payloadEnd = payloadStart + declaredLength;

	// Check if instruction bytes are present
	if (payloadEnd > data.length) return false;

	// Extract payload (instruction + optional separator + url)
	// We need the full remaining data for CRC check
	const remaining = data.subarray(payloadStart);
	const payload = remaining;

	// CRC32 check
	const declaredCrc = data.readUInt32BE(OFFSET_CHECKSUM);
	const actualCrc = crc32(payload) >>> 0;
	if (declaredCrc !== actualCrc) return false;

	// UTF-8 check on the instruction portion
	const instructionBuf = data.subarray(payloadStart, payloadEnd);
	try {
		const text = instructionBuf.toString("utf-8");
		if (text.includes("\uFFFD")) return false;
	} catch {
		return false;
	}

	return true;
}

/**
 * Parse a validated envelope buffer into instruction + optional nextUrl.
 * Call validateEnvelope() first — this function assumes the envelope is valid.
 */
export function parseEnvelope(data: Buffer): EnvelopeParseResult {
	const declaredLength = data.readUInt32BE(OFFSET_LENGTH);
	const instruction = data.subarray(
		OFFSET_INSTRUCTION,
		OFFSET_INSTRUCTION + declaredLength,
	).toString("utf-8");

	// Check for separator + nextUrl after the instruction
	const afterInstruction = OFFSET_INSTRUCTION + declaredLength;
	const remaining = data.subarray(afterInstruction);

	if (remaining.length <= SEPARATOR.length) {
		return { instruction };
	}

	// Look for separator at the start of remaining
	if (remaining.subarray(0, SEPARATOR.length).equals(SEPARATOR)) {
		const nextUrl = remaining.subarray(SEPARATOR.length).toString("utf-8");
		return { instruction, nextUrl: nextUrl || undefined };
	}

	return { instruction };
}

/**
 * Convenience: build envelope, validate, and parse in one.
 * Used for testing encrypt→decrypt roundtrips.
 */
export function roundtrip(instruction: string, nextUrl?: string): {
	envelope: Buffer;
	valid: boolean;
	parsed: EnvelopeParseResult | null;
} {
	const envelope = buildEnvelope(instruction, nextUrl);
	const valid = validateEnvelope(envelope);
	const parsed = valid ? parseEnvelope(envelope) : null;
	return { envelope, valid, parsed };
}
