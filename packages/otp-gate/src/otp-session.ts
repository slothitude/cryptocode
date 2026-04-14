import { DualChannel } from "./dual-channel.js";
import {
	convertToLlmMessage,
	AUTHENTICATED_MARKER,
	UNAUTHENTICATED_MARKER,
} from "./convert-to-llm.js";
import { saveSession } from "@cryptocode/otp-core";
import type { EncryptedMessage, SecurityMode } from "@cryptocode/otp-core";

export interface OTPSessionCallbacks {
	/** Called when a message is successfully authenticated. */
	onAuthenticated?: (instruction: string) => void;
	/** Called when a message fails authentication. */
	onUnauthenticated?: (raw: Buffer, reason: string) => void;
	/** Called to send a prepared LLM message string to the agent. */
	onSendToAgent: (message: string) => Promise<void>;
}

/**
 * Wraps an agent session with OTP encryption/decryption.
 *
 * The user's plaintext message is encrypted before entering the agent pipeline.
 * On the agent side, the ciphertext is decrypted and validated.
 * Only authenticated messages reach the LLM.
 */
export class OTPSession {
	private readonly channel: DualChannel;
	private readonly mode: SecurityMode;
	private readonly callbacks: OTPSessionCallbacks;

	constructor(
		channel: DualChannel,
		mode: SecurityMode,
		callbacks: OTPSessionCallbacks,
	) {
		this.channel = channel;
		this.mode = mode;
		this.callbacks = callbacks;
	}

	/**
	 * Process a user message: encrypt it for the U→A channel.
	 * Returns the encrypted message to be transmitted.
	 */
	async encryptOutgoing(text: string, nextUrl?: string): Promise<EncryptedMessage> {
		return this.channel.encryptUserMessage(text, nextUrl);
	}

	/**
	 * Process an incoming encrypted user message on the agent side:
	 * decrypt, validate, and convert to LLM format.
	 */
	async processIncoming(msg: EncryptedMessage): Promise<string | null> {
		const result = await this.channel.decryptUserMessage(msg);
		const llmMessage = convertToLlmMessage(
			result.instruction,
			result.authenticated,
			this.mode,
		);

		if (result.authenticated) {
			this.callbacks.onAuthenticated?.(result.instruction);
		} else {
			this.callbacks.onUnauthenticated?.(result.raw, "Decryption validation failed");
		}

		return llmMessage;
	}

	/**
	 * Encrypt an agent response for the A→U channel.
	 */
	async encryptResponse(
		text: string,
		nextUrl?: string,
	): Promise<EncryptedMessage> {
		return this.channel.encryptAgentResponse(text, nextUrl);
	}

	/**
	 * Decrypt an agent response on the user side.
	 */
	async decryptResponse(msg: EncryptedMessage): Promise<string | null> {
		const result = await this.channel.decryptAgentResponse(msg);
		if (!result.authenticated) return null;
		return result.instruction;
	}

	/** Get remaining pad bytes for status display. */
	getStatus(): { uaRemaining: number; auRemaining: number } {
		return {
			uaRemaining: this.channel.getUAPadRemaining(),
			auRemaining: this.channel.getAUPadRemaining(),
		};
	}
}
