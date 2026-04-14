import { createHash } from "node:crypto";
import { DualChannel } from "@cryptocode/otp-gate";
import type { HelloMessage, ControlMessage } from "./types.js";

/** Protocol version for wire communication. */
const WIRE_PROTOCOL_VERSION = 1;

export interface NegotiationResult {
	success: boolean;
	error?: string;
}

/**
 * Handles session negotiation between WireServer and WireClient.
 *
 * Two modes:
 * - **Local mode**: Both sides share the same session file. HELLO handshake
 *   verifies both loaded the same session by comparing a SHA-256 hash of
 *   channel state (position + sequence).
 * - **Remote mode**: ECDH seed URL exchange over WebSocket. (Future — stubbed.)
 */
export class SessionNegotiator {
	private readonly role: "client" | "server";
	private readonly channel: DualChannel;

	constructor(role: "client" | "server", channel: DualChannel) {
		this.role = role;
		this.channel = channel;
	}

	/**
	 * Start local-mode negotiation by generating a HELLO message.
	 * Call this first, then send the returned message to the peer.
	 */
	startLocalNegotiation(): HelloMessage {
		return {
			type: "HELLO",
			version: WIRE_PROTOCOL_VERSION,
			sessionHash: this.computeSessionHash(),
		};
	}

	/**
	 * Complete local-mode negotiation by verifying the peer's HELLO.
	 * Returns success if the session hashes match.
	 */
	completeLocalNegotiation(peerHello: ControlMessage): NegotiationResult {
		if (peerHello.type !== "HELLO") {
			return { success: false, error: `Expected HELLO, got ${peerHello.type}` };
		}

		const hello = peerHello as HelloMessage;

		if (hello.version !== WIRE_PROTOCOL_VERSION) {
			return {
				success: false,
				error: `Version mismatch: local=${WIRE_PROTOCOL_VERSION}, remote=${hello.version}`,
			};
		}

		if (!hello.sessionHash) {
			return { success: false, error: "Peer did not provide session hash" };
		}

		const localHash = this.computeSessionHash();
		if (localHash !== hello.sessionHash) {
			return {
				success: false,
				error: `Session hash mismatch: local=${localHash}, remote=${hello.sessionHash}`,
			};
		}

		return { success: true };
	}

	/**
	 * Compute a SHA-256 hash of the current channel state.
	 * This allows both sides to verify they loaded the same session.
	 */
	private computeSessionHash(): string {
		const uaState = this.channel["userToAgent"].toState();
		const auState = this.channel["agentToUser"].toState();

		const stateData = JSON.stringify({
			uaPosition: uaState.position,
			uaSequence: uaState.sequence,
			uaCurrentUrl: uaState.currentUrl,
			auPosition: auState.position,
			auSequence: auState.sequence,
			auCurrentUrl: auState.currentUrl,
		});

		return createHash("sha256").update(stateData).digest("hex");
	}
}
