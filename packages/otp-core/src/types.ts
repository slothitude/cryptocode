/** Result of attempting to decrypt a message. */
export interface DecryptedResult {
	/** Whether the ciphertext decrypted to valid envelope format. */
	authenticated: boolean;
	/** The recovered instruction (empty string if unauthenticated). */
	instruction: string;
	/** The next Wikipedia article URL embedded in the message, if any. */
	nextUrl?: string;
	/** Raw decrypted bytes (for diagnostics in audit mode). */
	raw: Buffer;
	/** If a desync was detected, contains the desync details. */
	dsync?: DesyncInfo;
}

/** Details about a detected pad position desync. */
export interface DesyncInfo {
	/** Sequence number the sender used. */
	senderSeq: number;
	/** Sequence number the receiver expected. */
	receiverSeq: number;
	/** Pad position the sender was at when encrypting. */
	senderPosition: number;
	/** Pad position the receiver was at when attempting decrypt. */
	receiverPosition: number;
	/**
	 * The recovery URL: the last URL that was successfully embedded
	 * in a decrypted message. Both sides re-fetch this URL on wobbly.
	 */
	recoveryUrl: string;
}

/** An encrypted message traveling over a channel. */
export interface EncryptedMessage {
	/** The XOR-encrypted bytes. */
	ciphertext: Buffer;
	/** Number of pad bytes consumed. */
	padBytesUsed: number;
	/** Position in the pad when this message was encrypted. */
	padPosition: number;
	/** Monotonically increasing sequence number for desync detection. */
	sequence: number;
}

/** Persistent state for a single channel's pad chain. */
export interface ChannelState {
	/** The original seed URL that started this chain. */
	seedUrl: string;
	/** Current byte position in the pad buffer. */
	position: number;
	/** The URL currently being used as pad source. */
	currentUrl: string;
	/** SHA-256 hash of the remaining buffer for integrity checks. */
	bufferHash: string;
	/** Pad refill threshold in bytes. */
	lowWaterMark: number;
	/** Current sequence number for this channel. */
	sequence: number;
	/**
	 * The last URL that was successfully embedded in a decrypted message.
	 * Used as the wobbly recovery anchor — both sides re-fetch this URL.
	 */
	lastSuccessfulUrl: string;
}

/** Full session state persisted to disk. */
export interface SessionState {
	version: number;
	channels: {
		userToAgent: ChannelState;
		agentToUser: ChannelState;
	};
	createdAt: string;
}

/** Security modes for handling unauthenticated messages. */
export type SecurityMode = "strict" | "lenient" | "audit";

/** Reason why a message was rejected. */
export type RejectionReason = "desync" | "injection" | "malformed";
