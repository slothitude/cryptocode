/**
 * TUI client — user-facing terminal interface.
 *
 * 1. Restores DualChannel from the same session file (local mode)
 * 2. Connects to the agent's WireServer via WebSocket
 * 3. Interactive readline loop
 * 4. On user input: encrypt and send to agent
 * 5. On agent events: display streaming text, tool calls, results
 *
 * No pi-mono dependency on the TUI side.
 */
import * as readline from "node:readline";
import { restoreSession } from "./core/session-init.js";
import { WireClient } from "@cryptocode/otp-wire";

export interface TuiClientOptions {
	/** WebSocket URL of the agent server. */
	agentUrl: string;
}

export async function startTuiClient(options: TuiClientOptions): Promise<void> {
	// Restore session (must be the same session as the agent)
	const { channel } = await restoreSession();

	const client = new WireClient({
		url: options.agentUrl,
		channel,
	});

	// Display agent events
	let currentText = "";
	client.onAgentEvent((event) => {
		const type = event.type as string;

		switch (type) {
			case "turn_start":
				currentText = "";
				break;

			case "message_update": {
				const msg = event.message as { content?: string } | undefined;
				if (msg?.content && typeof msg.content === "string") {
					// Streaming text — overwrite current line
					currentText = msg.content;
					process.stdout.write(`\r  agent: ${currentText}`);
				}
				break;
			}

			case "message_end":
				// Finalize the line
				if (currentText) {
					process.stdout.write("\n");
				}
				break;

			case "tool_execution_start": {
				const name = event.toolName as string;
				const args = event.args as Record<string, unknown> | undefined;
				const summary = args ? JSON.stringify(args).slice(0, 80) : "";
				console.log(`  tool: ${name} ${summary}...`);
				break;
			}

			case "tool_execution_end": {
				const name = event.toolName as string;
				const isError = event.isError as boolean;
				if (isError) {
					console.log(`  tool: ${name} — error`);
				}
				break;
			}

			case "turn_end":
				currentText = "";
				break;

			case "agent_end":
				// Turn complete
				break;
		}
	});

	client.on("disconnected", () => {
		console.log("\nDisconnected from agent.");
		process.exit(0);
	});

	client.on("error", (err: Error) => {
		console.error("Connection error:", err.message);
	});

	// Connect
	await client.connect();
	console.log(`Connected to agent at ${options.agentUrl}`);

	console.log("\nCryptocode TUI active. Type messages (Ctrl+C to quit).\n");

	// Interactive loop
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
				await client.sendUserMessage(input);
			} catch (err) {
				console.error("  Error:", err instanceof Error ? err.message : err);
			}

			prompt();
		});
	};

	prompt();

	// Handle Ctrl+C
	process.on("SIGINT", () => {
		console.log("\nShutting down...");
		client.close();
		process.exit(0);
	});
}
