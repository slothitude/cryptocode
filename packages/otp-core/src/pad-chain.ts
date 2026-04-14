/**
 * Pad chain — backward-compatible wrapper around the envelope format.
 *
 * The actual encoding/decoding now lives in otp-cipher.ts (buildEnvelope,
 * validateEnvelope, parseEnvelope). This module re-exports a PadChain class
 * that delegates to the envelope functions.
 */

import {
	buildEnvelope,
	validateEnvelope,
	parseEnvelope,
} from "./otp-cipher.js";
import type { EnvelopeParseResult } from "./otp-cipher.js";

export class PadChain {
	/**
	 * Encode an instruction and optional next URL into a full envelope buffer.
	 */
	encodeMessage(instruction: string, nextUrl?: string): Buffer {
		return buildEnvelope(instruction, nextUrl);
	}

	/**
	 * Validate an envelope buffer.
	 */
	validateMessage(data: Buffer): boolean {
		return validateEnvelope(data);
	}

	/**
	 * Decode a validated envelope buffer back into instruction + optional next URL.
	 */
	decodeMessage(data: Buffer): { instruction: string; nextUrl?: string } {
		return parseEnvelope(data);
	}
}

// Re-export envelope types for convenience
export type { EnvelopeParseResult };
