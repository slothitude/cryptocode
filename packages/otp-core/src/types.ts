/** Result of attempting to decrypt a message. */
export interface DecryptedResult {
	/** Whether the ciphertext decrypted to valid UTF-8 with correct format. */
	authenticated: boolean;
	/** The recovered instruction (empty string if unauthenticated). */
	instruction: string;
	/** The next Wikipedia article URL embedded in the message, if any. */
	nextUrl?: string;
	/** Raw decrypted bytes (for diagnostics in audit mode). */
	raw: Buffer;
}

/** An encrypted message traveling over a channel. */
export interface EncryptedMessage {
	/** The XOR-encrypted bytes. */
	ciphertext: Buffer;
	/** Number of pad bytes consumed. */
	padBytesUsed: number;
	/** Position in the pad when this message was encrypted. */
	padPosition: number;
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
