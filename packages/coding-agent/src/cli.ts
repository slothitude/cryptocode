#!/usr/bin/env node
/**
 * Cryptocode CLI — cryptographically secured coding agent.
 *
 * Commands:
 *   cryptocode keygen
 *     Generate an ECDH keypair for handshake.
 *
 *   cryptocode init [--user-seed-url URL] [--agent-seed-url URL]
 *                    [--private-key HEX] [--remote-public-key HEX]
 *     Initialize a new session with optional ECDH handshake.
 *
 *   cryptocode session
 *     Show current session state.
 *
 *   cryptocode start [--mode strict|lenient|audit]
 *     Start the interactive coding agent (two-process: agent + TUI).
 *
 *   cryptocode agent --port PORT [--mode strict|lenient|audit]
 *     Start the agent server (headless daemon with LLM access).
 *
 *   cryptocode tui --agent ws://HOST:PORT
 *     Start the TUI client (user-facing terminal interface).
 */
import { startCryptocode } from "./main.js";
import { startAgentServer } from "./agent-server.js";
import { startTuiClient } from "./tui-client.js";
import {
	sessionExists,
	encryptedSessionExists,
	loadSession,
	deleteSession,
} from "@cryptocode/otp-core";
import { CONFIG } from "./core/config.js";
import { initSession, generateHandshakeKeys } from "./core/session-init.js";

function parseArgs(args: string[]): Record<string, string> {
	const parsed: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i].startsWith("--")) {
			const key = args[i].slice(2);
			const value = args[i + 1];
			if (value && !value.startsWith("--")) {
				parsed[key] = value;
				i++;
			} else {
				parsed[key] = "true";
			}
		}
	}
	return parsed;
}

async function main(): Promise<void> {
	const command = process.argv[2];
	const args = parseArgs(process.argv.slice(3));

	switch (command) {
		case "keygen": {
			const keys = generateHandshakeKeys();
			console.log("ECDH keypair generated (secp256k1):");
			console.log(`  Public key:  ${keys.publicKeyHex}`);
			console.log(`  Private key: ${keys.privateKeyHex}`);
			console.log("\nShare your public key with the other party.");
			console.log("Keep your private key secret.");
			break;
		}

		case "init": {
			const userSeedUrl =
				args["user-seed-url"] ?? "https://en.wikipedia.org/wiki/Cryptography";
			const agentSeedUrl =
				args["agent-seed-url"] ?? "https://en.wikipedia.org/wiki/One-time_pad";

			if (sessionExists()) {
				console.log("Session already exists. Delete it first with 'cryptocode delete'.");
				process.exit(1);
			}

			// Optional ECDH handshake
			const privateKey = args["private-key"];
			const remotePublicKey = args["remote-public-key"];

			let handshakeKey: { localPrivateKey: string; remotePublicKey: string } | undefined;
			if (privateKey && remotePublicKey) {
				handshakeKey = { localPrivateKey: privateKey, remotePublicKey: remotePublicKey };
			} else if (privateKey || remotePublicKey) {
				console.error("Both --private-key and --remote-public-key are required for ECDH handshake.");
				process.exit(1);
			}

			await initSession(userSeedUrl, agentSeedUrl, handshakeKey);
			console.log("Session initialized successfully.");
			break;
		}

		case "session": {
			if (encryptedSessionExists()) {
				console.log("Encrypted session exists (session.enc).");
				console.log("Use --private-key and --remote-public-key with 'cryptocode start' to decrypt.");
			} else if (sessionExists() && !encryptedSessionExists()) {
				const state = loadSession();
				console.log("Session state:");
				console.log(JSON.stringify(state, null, 2));
			} else {
				console.log("No active session. Run 'cryptocode init' first.");
				process.exit(1);
			}
			break;
		}

		case "delete": {
			if (!sessionExists()) {
				console.log("No session to delete.");
				process.exit(1);
			}
			deleteSession();
			console.log("Session deleted.");
			break;
		}

		case "start": {
			const mode = args.mode ?? "lenient";
			if (!["strict", "lenient", "audit"].includes(mode)) {
				console.error(`Invalid mode: ${mode}. Use strict, lenient, or audit.`);
				process.exit(1);
			}
			await startCryptocode({
				securityMode: mode as "strict" | "lenient" | "audit",
				userSeedUrl: args["user-seed-url"],
				agentSeedUrl: args["agent-seed-url"],
			});
			break;
		}

		case "agent": {
			const port = parseInt(args.port ?? "9876", 10);
			if (isNaN(port) || port < 1 || port > 65535) {
				console.error("Invalid port. Use --port NUMBER (1-65535).");
				process.exit(1);
			}
			const mode = args.mode ?? "lenient";
			if (!["strict", "lenient", "audit"].includes(mode)) {
				console.error(`Invalid mode: ${mode}. Use strict, lenient, or audit.`);
				process.exit(1);
			}
			const echo = args.echo === "true";
			const server = await startAgentServer({
				port,
				securityMode: mode as "strict" | "lenient" | "audit",
				echo,
			});
			console.log(`Agent server listening on port ${port}`);
			console.log("Waiting for TUI client to connect...");

			// Keep alive until shutdown
			await new Promise<void>((resolve) => {
				server.on("shutdown", () => resolve());
				process.on("SIGINT", () => {
					server.close().then(() => resolve());
				});
			});
			break;
		}

		case "tui": {
			const agentUrl = args.agent;
			if (!agentUrl) {
				console.error("Missing --agent URL. Usage: cryptocode tui --agent ws://localhost:9876");
				process.exit(1);
			}
			await startTuiClient({ agentUrl });
			break;
		}

		default:
			console.log(`Cryptocode — cryptographically secured coding agent

Usage:
  cryptocode keygen
    Generate an ECDH keypair for handshake (secp256k1).

  cryptocode init [--user-seed-url URL] [--agent-seed-url URL]
                  [--private-key HEX] [--remote-public-key HEX]
    Initialize a new session. With --private-key and --remote-public-key,
    performs ECDH handshake and encrypts session at rest.

  cryptocode session
    Show current session state.

  cryptocode delete
    Delete the current session.

  cryptocode start [--mode strict|lenient|audit]
    Start the interactive coding agent (two-process: agent + TUI).

  cryptocode agent --port PORT [--mode strict|lenient|audit] [--echo]
    Start the agent server (headless daemon with LLM access).
    Use --echo for echo mode (no API key required, for testing).

  cryptocode tui --agent ws://HOST:PORT
    Start the TUI client (user-facing terminal interface).

Options:
  --user-seed-url URL         Wikipedia URL for U→A channel pad
  --agent-seed-url URL        Wikipedia URL for A→U channel pad
  --private-key HEX           Your ECDH private key (from keygen)
  --remote-public-key HEX     Other party's ECDH public key
  --mode MODE                 Security mode: strict, lenient (default), or audit
  --port PORT                 Port for agent server (default: 9876)
  --echo                      Use echo mode (no API key required, for testing)
  --agent URL                 WebSocket URL of agent for TUI client
`);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
