#!/usr/bin/env node
/**
 * Cryptocode CLI — cryptographically secured coding agent.
 *
 * Commands:
 *   cryptocode init [--user-seed-url URL] [--agent-seed-url URL]
 *     Initialize a new session with seed Wikipedia articles.
 *
 *   cryptocode session
 *     Show current session state.
 *
 *   cryptocode start [--mode strict|lenient|audit]
 *     Start the interactive coding agent.
 */
import { startCryptocode } from "./main.js";
import {
	sessionExists,
	loadSession,
	deleteSession,
} from "@cryptocode/otp-core";
import { CONFIG } from "./core/config.js";
import { initSession } from "./core/session-init.js";

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
		case "init": {
			const userSeedUrl =
				args["user-seed-url"] ?? "https://en.wikipedia.org/wiki/Cryptography";
			const agentSeedUrl =
				args["agent-seed-url"] ?? "https://en.wikipedia.org/wiki/One-time_pad";

			if (sessionExists()) {
				console.log("Session already exists. Delete it first with 'cryptocode delete'.");
				process.exit(1);
			}

			await initSession(userSeedUrl, agentSeedUrl);
			console.log("Session initialized successfully.");
			break;
		}

		case "session": {
			if (!sessionExists()) {
				console.log("No active session. Run 'cryptocode init' first.");
				process.exit(1);
			}
			const state = loadSession();
			console.log("Session state:");
			console.log(JSON.stringify(state, null, 2));
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

		default:
			console.log(`Cryptocode — cryptographically secured coding agent

Usage:
  cryptocode init [--user-seed-url URL] [--agent-seed-url URL]
    Initialize a new session with seed Wikipedia articles.

  cryptocode session
    Show current session state.

  cryptocode delete
    Delete the current session.

  cryptocode start [--mode strict|lenient|audit]
    Start the interactive coding agent.

Options:
  --user-seed-url URL    Wikipedia URL for U→A channel pad (default: Cryptography article)
  --agent-seed-url URL   Wikipedia URL for A→U channel pad (default: One-time_pad article)
  --mode MODE            Security mode: strict, lenient (default), or audit
`);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
