import {
	PadManager,
	PadChain,
	encrypt,
	decrypt,
	buildEnvelope,
	validateEnvelope,
	parseEnvelope,
} from "@cryptocode/otp-core";
import type {
	DecryptedResult,
	DesyncInfo,
	EncryptedMessage,
} from "@cryptocode/otp-core";

/** The number of consecutive failures before triggering automatic resync. */
const DESYNC_THRESHOLD = 3;

/**
 * Manages both directional pad channels with spec-compliant desync recovery.
 *
 * Desync recovery (spec Phase 3):
 * On desync, both sides re-fetch lastSuccessfulUrl (the last URL that was
 * transmitted inside a successfully decrypted message). No HMAC derivation
 * needed — the URL is already shared knowledge via ciphertext.
 */
export class DualChannel {
	public readonly userToAgent: PadManager;
	public readonly agentToUser: PadManager;
	private readonly chain: PadChain;
	private consecutiveFailuresUA: number = 0;
	private consecutiveFailuresAU: number = 0;

	constructor(userToAgent: PadManager, agentToUser: PadManager) {
		this.userToAgent = userToAgent;
		this.agentToUser = agentToUser;
		this.chain = new PadChain();
	}

	/**
	 * Encrypt a user message for the U→A channel.
	 * Builds the full envelope (version + length + CRC32 + instruction + opt nextUrl).
	 */
	async encryptUserMessage(
		text: string,
		nextUrl?: string,
	): Promise<EncryptedMessage> {
		const envelope = this.chain.encodeMessage(text, nextUrl);
		const position = this.userToAgent.getPosition();
		const seq = this.userToAgent.getSequence();
		const pad = await this.userToAgent.advance(envelope.length, nextUrl);
		const ciphertext = encrypt(envelope, pad);
		return {
			ciphertext,
			padBytesUsed: envelope.length,
			padPosition: position,
			sequence: seq,
		};
	}

	/**
	 * Decrypt a user message on the U→A channel.
	 * On success, updates lastSuccessfulUrl if the message contains a nextUrl.
	 */
	async decryptUserMessage(msg: EncryptedMessage): Promise<DecryptedResult> {
		const expectedSeq = this.userToAgent.getSequence();

		// Phase 1: Sequence number mismatch → desync
		if (msg.sequence !== expectedSeq) {
			const dsync = this.buildDesyncInfo(this.userToAgent, msg, expectedSeq);
			this.consecutiveFailuresUA++;
			return {
				authenticated: false,
				instruction: "",
				raw: msg.ciphertext,
				dsync,
			};
		}

		// Phase 2: Decrypt and validate envelope
		const pad = await this.userToAgent.advance(msg.padBytesUsed);
		const raw = decrypt(msg.ciphertext, pad);
		const valid = validateEnvelope(raw);

		if (!valid) {
			this.consecutiveFailuresUA++;
			return { authenticated: false, instruction: "", raw };
		}

		// Success — reset failure counter, update recovery anchor
		this.consecutiveFailuresUA = 0;

		const { instruction, nextUrl } = parseEnvelope(raw);

		// If message carries a nextUrl, that becomes our new recovery anchor
		if (nextUrl) {
			this.userToAgent.setLastSuccessfulUrl(nextUrl);
		}

		return { authenticated: true, instruction, nextUrl, raw };
	}

	/**
	 * Encrypt an agent response for the A→U channel.
	 */
	async encryptAgentResponse(
		text: string,
		nextUrl?: string,
	): Promise<EncryptedMessage> {
		const envelope = this.chain.encodeMessage(text, nextUrl);
		const position = this.agentToUser.getPosition();
		const seq = this.agentToUser.getSequence();
		const pad = await this.agentToUser.advance(envelope.length, nextUrl);
		const ciphertext = encrypt(envelope, pad);
		return {
			ciphertext,
			padBytesUsed: envelope.length,
			padPosition: position,
			sequence: seq,
		};
	}

	/**
	 * Decrypt an agent response on the A→U channel.
	 */
	async decryptAgentResponse(msg: EncryptedMessage): Promise<DecryptedResult> {
		const expectedSeq = this.agentToUser.getSequence();

		if (msg.sequence !== expectedSeq) {
			const dsync = this.buildDesyncInfo(this.agentToUser, msg, expectedSeq);
			this.consecutiveFailuresAU++;
			return {
				authenticated: false,
				instruction: "",
				raw: msg.ciphertext,
				dsync,
			};
		}

		const pad = await this.agentToUser.advance(msg.padBytesUsed);
		const raw = decrypt(msg.ciphertext, pad);
		const valid = validateEnvelope(raw);

		if (!valid) {
			this.consecutiveFailuresAU++;
			return { authenticated: false, instruction: "", raw };
		}

		this.consecutiveFailuresAU = 0;

		const { instruction, nextUrl } = parseEnvelope(raw);

		if (nextUrl) {
			this.agentToUser.setLastSuccessfulUrl(nextUrl);
		}

		return { authenticated: true, instruction, nextUrl, raw };
	}

	/**
	 * Recover from desync using spec Phase 3 procedure:
	 * Re-fetch lastSuccessfulUrl, reset position to 0.
	 * Both sides have the same lastSuccessfulUrl so both recover identically.
	 */
	async recoverFromDesync(
		channel: "userToAgent" | "agentToUser",
	): Promise<string> {
		const manager = channel === "userToAgent" ? this.userToAgent : this.agentToUser;
		const recoveryUrl = manager.getLastSuccessfulUrl();
		await manager.resync();

		if (channel === "userToAgent") {
			this.consecutiveFailuresUA = 0;
		} else {
			this.consecutiveFailuresAU = 0;
		}

		return recoveryUrl;
	}

	/** Check if U→A channel should auto-resync. */
	shouldAutoResyncUA(): boolean {
		return this.consecutiveFailuresUA >= DESYNC_THRESHOLD;
	}

	/** Check if A→U channel should auto-resync. */
	shouldAutoResyncAU(): boolean {
		return this.consecutiveFailuresAU >= DESYNC_THRESHOLD;
	}

	/**
	 * Auto-recover: re-fetch lastSuccessfulUrl and resync.
	 * Called when shouldAutoResync*() returns true.
	 */
	async autoRecover(channel: "userToAgent" | "agentToUser"): Promise<string> {
		return this.recoverFromDesync(channel);
	}

	/** Bytes remaining in the U→A pad. */
	getUAPadRemaining(): number {
		return this.userToAgent.getRemaining();
	}

	/** Bytes remaining in the A→U pad. */
	getAUPadRemaining(): number {
		return this.agentToUser.getRemaining();
	}

	/**
	 * Build desync info. Recovery URL = lastSuccessfulUrl (spec-compliant).
	 */
	private buildDesyncInfo(
		manager: PadManager,
		msg: EncryptedMessage,
		expectedSeq: number,
	): DesyncInfo {
		return {
			senderSeq: msg.sequence,
			receiverSeq: expectedSeq,
			senderPosition: msg.padPosition,
			receiverPosition: manager.getPosition(),
			recoveryUrl: manager.getLastSuccessfulUrl(),
		};
	}
}
