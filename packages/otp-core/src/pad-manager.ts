import { createHash } from "node:crypto";
import { fetchUrl } from "./url-fetcher.js";
import type { ChannelState } from "./types.js";

const DEFAULT_LOW_WATER_MARK = 10_240; // 10 KB

/**
 * Manages a single pad chain: a buffer of random-ish bytes derived from
 * fetched URLs, with a read position that advances monotonically.
 *
 * True OTP property: consumed bytes are discarded and never reused.
 *
 * Desync recovery (spec Phase 3 — "chuck a wobbly"):
 * Tracks lastSuccessfulUrl — the last URL that was successfully embedded
 * in a decrypted message. On desync, both sides re-fetch this URL from
 * scratch and reset position to 0. No HMAC derivation needed; the URL
 * is already known to both sides because it was transmitted in ciphertext.
 */
export class PadManager {
	private buffer: Buffer;
	private position: number;
	private sourceUrl: string;
	private lowWaterMark: number;
	private sequence: number;
	private lastSuccessfulUrl: string;

	constructor(
		initialUrl: string,
		initialBuffer?: Buffer,
		initialPosition: number = 0,
		lowWaterMark: number = DEFAULT_LOW_WATER_MARK,
		initialSequence: number = 0,
	) {
		this.sourceUrl = initialUrl;
		this.buffer = initialBuffer ?? Buffer.alloc(0);
		this.position = initialPosition;
		this.lowWaterMark = lowWaterMark;
		this.sequence = initialSequence;
		this.lastSuccessfulUrl = initialUrl;
	}

	/** Get the next N pad bytes. Throws if pad exhausted and no refill URL available. */
	async advance(n: number, refillUrl?: string): Promise<Buffer> {
		// Check if we need to refill
		if (this.getRemaining() - n < this.lowWaterMark && refillUrl) {
			await this.appendFromUrl(refillUrl);
		}

		if (this.position + n > this.buffer.length) {
			throw new Error(
				`Pad exhausted: need ${n} bytes at position ${this.position}, ` +
					`but buffer only has ${this.buffer.length} bytes total ` +
					`(${this.getRemaining()} remaining).`,
			);
		}

		const slice = this.buffer.subarray(this.position, this.position + n);
		this.position += n;
		this.sequence++;

		// Periodically discard consumed bytes to free memory (every 1MB)
		if (this.position > 1_048_576) {
			this.discardUsed();
		}

		return Buffer.from(slice); // Return a copy
	}

	/** Bytes remaining in the buffer from current position. */
	getRemaining(): number {
		return this.buffer.length - this.position;
	}

	/** Current read position. */
	getPosition(): number {
		return this.position;
	}

	/** Current source URL. */
	getSourceUrl(): string {
		return this.sourceUrl;
	}

	/** Current sequence number. */
	getSequence(): number {
		return this.sequence;
	}

	/**
	 * The last URL that was successfully embedded in a decrypted message.
	 * This is the wobbly recovery anchor — both sides re-fetch this URL.
	 */
	getLastSuccessfulUrl(): string {
		return this.lastSuccessfulUrl;
	}

	/**
	 * Update the last successful URL. Called when a message containing
	 * a nextUrl is successfully decrypted — that nextUrl becomes the
	 * new recovery anchor.
	 */
	setLastSuccessfulUrl(url: string): void {
		this.lastSuccessfulUrl = url;
	}

	/** Increment sequence without advancing pad (for skipped messages). */
	skipSequence(): void {
		this.sequence++;
	}

	/** Fetch a URL and append its raw bytes to the pad buffer. */
	async appendFromUrl(url: string): Promise<void> {
		const bytes = await fetchUrl(url);
		this.buffer = Buffer.concat([this.buffer, bytes]);
		this.sourceUrl = url;
	}

	/** Discard consumed bytes from the front of the buffer. */
	discardUsed(): void {
		if (this.position > 0) {
			this.buffer = this.buffer.subarray(this.position);
			this.position = 0;
		}
	}

	/**
	 * Resynchronize (spec Phase 3 — chuck a wobbly).
	 *
	 * Re-fetches the lastSuccessfulUrl from scratch and resets:
	 * - Position to 0
	 * - Sequence to 0
	 * - Buffer to the fresh URL content
	 *
	 * Both sides independently call this with the same URL (the one
	 * from the last successfully decrypted message). No HMAC derivation
	 * or communication needed.
	 */
	async resync(): Promise<void> {
		const bytes = await fetchUrl(this.lastSuccessfulUrl);
		this.buffer = bytes;
		this.position = 0;
		this.sequence = 0;
		this.sourceUrl = this.lastSuccessfulUrl;
	}

	/** SHA-256 hash of the remaining buffer. */
	getBufferHash(): string {
		const remaining = this.buffer.subarray(this.position);
		return createHash("sha256").update(remaining).digest("hex");
	}

	/** Serialize state for persistence. */
	toState(): ChannelState {
		this.discardUsed();
		return {
			seedUrl: this.sourceUrl,
			position: this.position,
			currentUrl: this.sourceUrl,
			bufferHash: this.getBufferHash(),
			lowWaterMark: this.lowWaterMark,
			sequence: this.sequence,
			lastSuccessfulUrl: this.lastSuccessfulUrl,
		};
	}

	/** Initialize a PadManager by fetching the seed URL. */
	static async fromSeed(
		seedUrl: string,
		lowWaterMark: number = DEFAULT_LOW_WATER_MARK,
	): Promise<PadManager> {
		const pm = new PadManager(seedUrl, undefined, 0, lowWaterMark);
		await pm.appendFromUrl(seedUrl);
		return pm;
	}
}
