import {
	PadManager,
	PadChain,
	encrypt,
	decrypt,
	validatePlaintext,
	preparePlaintext,
	extractPlaintext,
} from "@cryptocode/otp-core";
import type { DecryptedResult, EncryptedMessage } from "@cryptocode/otp-core";

/**
 * Manages both directional pad chains:
 * - U→A (user encrypts, agent decrypts)
 * - A→U (agent encrypts, user decrypts)
 */
export class DualChannel {
	public readonly userToAgent: PadManager;
	public readonly agentToUser: PadManager;
	private readonly chain: PadChain;

	constructor(userToAgent: PadManager, agentToUser: PadManager) {
		this.userToAgent = userToAgent;
		this.agentToUser = agentToUser;
		this.chain = new PadChain();
	}

	/**
	 * Encrypt a user message for the U→A channel.
	 * Optionally includes a next URL for pad chain continuation.
	 */
	async encryptUserMessage(
		text: string,
		nextUrl?: string,
	): Promise<EncryptedMessage> {
		const payload = this.chain.encodeMessage(text, nextUrl);
		const plaintext = preparePlaintext(
			payload.toString("utf-8"),
		);
		const position = this.userToAgent.getPosition();
		const pad = await this.userToAgent.advance(plaintext.length, nextUrl);
		const ciphertext = encrypt(plaintext, pad);
		return { ciphertext, padBytesUsed: plaintext.length, padPosition: position };
	}

	/**
	 * Decrypt a user message on the U→A channel.
	 * Returns authenticated=true only if the decrypted bytes pass validation.
	 */
	async decryptUserMessage(msg: EncryptedMessage): Promise<DecryptedResult> {
		const pad = await this.userToAgent.advance(msg.padBytesUsed);
		const raw = decrypt(msg.ciphertext, pad);
		const authenticated = validatePlaintext(raw);

		if (!authenticated) {
			return { authenticated: false, instruction: "", raw };
		}

		const extracted = extractPlaintext(raw);
		if (extracted === null) {
			return { authenticated: false, instruction: "", raw };
		}

		const payload = Buffer.from(extracted, "utf-8");
		const { instruction, nextUrl } = this.chain.decodeMessage(payload);
		return { authenticated: true, instruction, nextUrl, raw };
	}

	/**
	 * Encrypt an agent response for the A→U channel.
	 */
	async encryptAgentResponse(
		text: string,
		nextUrl?: string,
	): Promise<EncryptedMessage> {
		const payload = this.chain.encodeMessage(text, nextUrl);
		const plaintext = preparePlaintext(
			payload.toString("utf-8"),
		);
		const position = this.agentToUser.getPosition();
		const pad = await this.agentToUser.advance(plaintext.length, nextUrl);
		const ciphertext = encrypt(plaintext, pad);
		return { ciphertext, padBytesUsed: plaintext.length, padPosition: position };
	}

	/**
	 * Decrypt an agent response on the A→U channel.
	 */
	async decryptAgentResponse(msg: EncryptedMessage): Promise<DecryptedResult> {
		const pad = await this.agentToUser.advance(msg.padBytesUsed);
		const raw = decrypt(msg.ciphertext, pad);
		const authenticated = validatePlaintext(raw);

		if (!authenticated) {
			return { authenticated: false, instruction: "", raw };
		}

		const extracted = extractPlaintext(raw);
		if (extracted === null) {
			return { authenticated: false, instruction: "", raw };
		}

		const payload = Buffer.from(extracted, "utf-8");
		const { instruction, nextUrl } = this.chain.decodeMessage(payload);
		return { authenticated: true, instruction, nextUrl, raw };
	}

	/** Bytes remaining in the U→A pad. */
	getUAPadRemaining(): number {
		return this.userToAgent.getRemaining();
	}

	/** Bytes remaining in the A→U pad. */
	getAUPadRemaining(): number {
		return this.agentToUser.getRemaining();
	}
}
