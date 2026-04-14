import { PadManager, saveSession } from "@cryptocode/otp-core";
import { DualChannel } from "@cryptocode/otp-gate";
import type { SessionState } from "@cryptocode/otp-core";
import { CONFIG } from "./config.js";

/**
 * Initialize a new cryptocode session with seed URLs for both channels.
 * Fetches the initial pad material and saves session state.
 */
export async function initSession(
	userSeedUrl: string,
	agentSeedUrl: string,
): Promise<{ channel: DualChannel; state: SessionState }> {
	console.log("Initializing cryptocode session...");
	console.log(`  U→A seed: ${userSeedUrl}`);
	console.log(`  A→U seed: ${agentSeedUrl}`);

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

	saveSession(state);
	console.log(`Session saved to ${CONFIG.sessionFile}`);

	return { channel, state };
}

/**
 * Restore a session from persisted state.
 * Re-fetches the pad material from the current URLs.
 */
export async function restoreSession(): Promise<{
	channel: DualChannel;
	state: SessionState;
}> {
	const { loadSession } = await import("@cryptocode/otp-core");
	const state = loadSession();

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
	// Advance to saved position
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
