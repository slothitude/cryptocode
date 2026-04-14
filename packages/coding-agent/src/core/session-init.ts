import {
	PadManager,
	saveSession,
	encryptSessionState,
	decryptSessionState,
	deriveSharedKey,
	generateKeyPairHex,
} from "@cryptocode/otp-core";
import { DualChannel } from "@cryptocode/otp-gate";
import type { SessionState } from "@cryptocode/otp-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config.js";

/**
 * Initialize a new cryptocode session with seed URLs for both channels.
 * Performs ECDH handshake and encrypts session state at rest.
 */
export async function initSession(
	userSeedUrl: string,
	agentSeedUrl: string,
	handshakeKey?: { localPrivateKey: string; remotePublicKey: string },
): Promise<{ channel: DualChannel; state: SessionState; encryptionKey?: Buffer }> {
	console.log("Initializing cryptocode session...");
	console.log(`  U→A seed: ${userSeedUrl}`);
	console.log(`  A→U seed: ${agentSeedUrl}`);

	// ECDH handshake
	let encryptionKey: Buffer | undefined;
	if (handshakeKey) {
		console.log("Performing ECDH handshake...");
		encryptionKey = deriveSharedKey(
			handshakeKey.localPrivateKey,
			handshakeKey.remotePublicKey,
		);
		console.log("  Shared secret derived.");
	}

	console.log("Fetching U→A pad material...");
	const uaPad = await PadManager.fromSeed(userSeedUrl, CONFIG.defaultLowWaterMark);
	console.log(`  Fetched ${uaPad.getRemaining()} bytes`);

	console.log("Fetching A→U pad material...");
	const auPad = await PadManager.fromSeed(agentSeedUrl, CONFIG.defaultLowWaterMark);
	console.log(`  Fetched ${auPad.getRemaining()} bytes`);

	const channel = new DualChannel(uaPad, auPad);

	const state: SessionState = {
		version: 1,
		channels: {
			userToAgent: uaPad.toState(),
			agentToUser: auPad.toState(),
		},
		createdAt: new Date().toISOString(),
	};

	// Encrypt session state at rest if we have a key
	if (encryptionKey) {
		const encrypted = encryptSessionState(state, encryptionKey);
		const encPath = path.join(getConfigDir(), "session.enc");
		fs.writeFileSync(encPath, encrypted);
		console.log(`Encrypted session saved to ${encPath}`);
	} else {
		saveSession(state);
		console.log(`Session saved to ${CONFIG.sessionFile}`);
	}

	return { channel, state, encryptionKey };
}

/**
 * Restore a session from persisted state.
 * Re-fetches the pad material from the current URLs.
 */
export async function restoreSession(
	encryptionKey?: Buffer,
): Promise<{
	channel: DualChannel;
	state: SessionState;
}> {
	const { loadSession, sessionExists, getConfigDir } = await import("@cryptocode/otp-core");
	let state: SessionState;

	if (encryptionKey) {
		// Load encrypted session
		const encPath = path.join(getConfigDir(), "session.enc");
		if (!fs.existsSync(encPath)) {
			throw new Error(`No encrypted session found at ${encPath}`);
		}
		const encrypted = fs.readFileSync(encPath);
		state = decryptSessionState(encrypted, encryptionKey);
		console.log("Encrypted session decrypted.");
	} else if (sessionExists()) {
		state = loadSession();
	} else {
		throw new Error("No session found. Run 'cryptocode init' first.");
	}

	console.log("Restoring session...");
	console.log(`  Created: ${state.createdAt}`);

	console.log("Restoring U→A pad...");
	const uaState = state.channels.userToAgent;
	const uaPad = new PadManager(
		uaState.currentUrl,
		undefined,
		0,
		uaState.lowWaterMark,
	);
	await uaPad.appendFromUrl(uaState.currentUrl);
	if (uaState.position > 0) {
		await uaPad.advance(uaState.position);
	}

	console.log("Restoring A→U pad...");
	const auState = state.channels.agentToUser;
	const auPad = new PadManager(
		auState.currentUrl,
		undefined,
		0,
		auState.lowWaterMark,
	);
	await auPad.appendFromUrl(auState.currentUrl);
	if (auState.position > 0) {
		await auPad.advance(auState.position);
	}

	const channel = new DualChannel(uaPad, auPad);
	console.log("Session restored.");

	return { channel, state };
}

/**
 * Generate ECDH keypair for handshake. Returns hex-encoded keys.
 */
export function generateHandshakeKeys(): {
	publicKeyHex: string;
	privateKeyHex: string;
} {
	return generateKeyPairHex();
}

function getConfigDir(): string {
	return CONFIG.configDir;
}
