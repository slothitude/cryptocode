/**
 * The pad chain encodes and decodes messages that carry the next
 * Wikipedia article title inside the encrypted payload.
 *
 * Plaintext format:
 *   [instruction_bytes][SEPARATOR][next_url]
 *
 * The separator is a sequence unlikely to appear in normal instructions.
 * If no nextUrl is provided, only the instruction bytes are sent.
 */

const SEPARATOR = Buffer.from("\x00\x01\x02\x03<<NEXT_URL>>\x03\x02\x01\x00", "utf-8");

export class PadChain {
	/**
	 * Encode an instruction and optional next URL into a single plaintext buffer.
	 */
	encodeMessage(instruction: string, nextUrl?: string): Buffer {
		const instructionBuf = Buffer.from(instruction, "utf-8");
		if (!nextUrl) {
			return instructionBuf;
		}
		const urlBuf = Buffer.from(nextUrl, "utf-8");
		return Buffer.concat([instructionBuf, SEPARATOR, urlBuf]);
	}

	/**
	 * Decode a decrypted buffer back into instruction + optional next URL.
	 */
	decodeMessage(decrypted: Buffer): { instruction: string; nextUrl?: string } {
		const sepIndex = findSeparator(decrypted);
		if (sepIndex === -1) {
			return { instruction: decrypted.toString("utf-8") };
		}
		const instruction = decrypted.subarray(0, sepIndex).toString("utf-8");
		const urlStart = sepIndex + SEPARATOR.length;
		const nextUrl = decrypted.subarray(urlStart).toString("utf-8");
		return { instruction, nextUrl: nextUrl || undefined };
	}
}

/** Find the separator sequence in a buffer. Returns -1 if not found. */
function findSeparator(buf: Buffer): number {
	if (buf.length < SEPARATOR.length) return -1;
	for (let i = 0; i <= buf.length - SEPARATOR.length; i++) {
		let match = true;
		for (let j = 0; j < SEPARATOR.length; j++) {
			if (buf[i + j] !== SEPARATOR[j]) {
				match = false;
				break;
			}
		}
		if (match) return i;
	}
	return -1;
}
