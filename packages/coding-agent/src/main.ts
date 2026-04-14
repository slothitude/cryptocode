import { DualChannel, OTPSession, OTP_SYSTEM_PROMPT_ADDON } from "@cryptocode/otp-gate";
import { initSession, restoreSession } from "./core/session-init.js";
import { CONFIG } from "./core/config.js";
import type { SecurityMode } from "@cryptocode/otp-core";
import { sessionExists, saveSession } from "@cryptocode/otp-core";

export interface CryptocodeOptions {
	/** Security mode for handling unauthenticated messages. */
	securityMode?: SecurityMode;
	/** User seed URL for U→A channel (required for init). */
	userSeedUrl?: string;
	/** Agent seed URL for A→U channel (required for init). */
	agentSeedUrl?: string;
}

/**
 * Main entry point for the cryptocode agent.
 * Initializes or restores the OTP session and starts the interactive loop.
 */
export async function startCryptocode(options: CryptocodeOptions = {}): Promise<void> {
	const mode: SecurityMode = options.securityMode ?? "lenient";

	let channel: DualChannel;

	if (options.userSeedUrl && options.agentSeedUrl) {
		// New session with provided seed URLs
		const result = await initSession(options.userSeedUrl, options.agentSeedUrl);
		channel = result.channel;
	} else if (sessionExists()) {
		// Restore existing session
		const result = await restoreSession();
		channel = result.channel;
	} else {
		console.error(
			"No session found. Provide seed URLs with --user-seed-url and --agent-seed-url,\n" +
				"or run 'cryptocode init' first.",
		);
		process.exit(1);
	}

	// Create OTP session wrapper
	const otpSession = new OTPSession(channel, mode, {
		onAuthenticated: (instruction: string) => {
			console.log(`[OTP OK] Authenticated: ${instruction.slice(0, 80)}...`);
		},
		onUnauthenticated: (raw: Buffer, reason: string) => {
			console.log(`[OTP FAIL] ${reason}. Raw bytes: ${raw.length}`);
		},
		onSendToAgent: async (message: string) => {
			// In a full integration, this would call pi-mono's AgentSession.prompt()
			console.log(`→ Agent: ${message.slice(0, 100)}...`);
		},
	});

	console.log("\nCryptocode session active. Type messages (Ctrl+C to quit).\n");
	console.log(`  Security mode: ${mode}`);
	console.log(`  U→A pad remaining: ${channel.getUAPadRemaining()} bytes`);
	console.log(`  A→U pad remaining: ${channel.getAUPadRemaining()} bytes`);
	console.log();

	// Simple interactive loop for demonstration
	// In production, this would be replaced by pi-mono's TUI
	const readline = await import("node:readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const prompt = (): void => {
		rl.question("cryptocode> ", async (input: string) => {
			if (!input.trim()) {
				prompt();
				return;
			}

			try {
				// Encrypt the user's message
				const encrypted = await otpSession.encryptOutgoing(input);

				// Simulate: decrypt on the "agent side"
				const llmMessage = await otpSession.processIncoming(encrypted);

				if (llmMessage) {
					console.log(`  Agent received: ${llmMessage}`);
				} else {
					console.log("  [Message rejected — unauthenticated]");
				}

				// Simulate an agent response
				const response = `Echo: ${input}`;
				const encResponse = await otpSession.encryptResponse(response);
				const decrypted = await otpSession.decryptResponse(encResponse);

				if (decrypted) {
					console.log(`  Agent response: ${decrypted}`);
				}

				// Save session state periodically
				saveSession({
					version: 1,
					channels: {
						userToAgent: channel["userToAgent"].toState(),
						agentToUser: channel["agentToUser"].toState(),
					},
					createdAt: new Date().toISOString(),
				});
			} catch (err) {
				console.error("  Error:", err instanceof Error ? err.message : err);
			}

			prompt();
		});
	};

	prompt();
}
