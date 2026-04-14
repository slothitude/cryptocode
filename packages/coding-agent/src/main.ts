import { DualChannel, OTPSession, OTP_SYSTEM_PROMPT_ADDON } from "@cryptocode/otp-gate";
import { initSession, restoreSession } from "./core/session-init.js";
import { CONFIG } from "./core/config.js";
import type { SecurityMode } from "@cryptocode/otp-core";
import { sessionExists, saveSession } from "@cryptocode/otp-core";
import { spawn } from "node:child_process";

export interface CryptocodeOptions {
	/** Security mode for handling unauthenticated messages. */
	securityMode?: SecurityMode;
	/** User seed URL for U→A channel (required for init). */
	userSeedUrl?: string;
	/** Agent seed URL for A→U channel (required for init). */
	agentSeedUrl?: string;
	/** Use legacy single-process demo loop instead of two-process. */
	legacy?: boolean;
	/** Port for the agent server (default: auto-assign). */
	port?: number;
}

/**
 * Start cryptocode as a two-process architecture:
 * 1. Spawn agent process on a port
 * 2. Wait for server ready
 * 3. Spawn TUI process connecting to the agent
 */
export async function startCryptocode(options: CryptocodeOptions = {}): Promise<void> {
	if (options.legacy) {
		return startLegacyLoop(options);
	}

	if (!sessionExists()) {
		console.error(
			"No session found. Run 'cryptocode init' first.",
		);
		process.exit(1);
	}

	const mode: SecurityMode = options.securityMode ?? "lenient";
	const port = options.port ?? 0; // 0 = auto-assign

	// Find an available port
	const actualPort = port || await getFreePort();

	// Spawn agent process
	console.log(`Starting agent server on port ${actualPort}...`);
	const agentProcess = spawn(
		process.execPath,
		[
			"--import", "tsx",
			"--no-warnings",
			...(await getTsconfigPaths()),
			"src/cli.ts",
			"agent",
			"--port", String(actualPort),
			"--mode", mode,
		],
		{
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		},
	);

	agentProcess.stdout?.on("data", (data: Buffer) => {
		const text = data.toString().trim();
		if (text) console.log(`[agent] ${text}`);
	});

	agentProcess.stderr?.on("data", (data: Buffer) => {
		const text = data.toString().trim();
		if (text) console.error(`[agent] ${text}`);
	});

	agentProcess.on("exit", (code) => {
		if (code && code !== 0) {
			console.error(`Agent process exited with code ${code}`);
		}
	});

	// Wait for agent to be ready
	await new Promise((resolve) => setTimeout(resolve, 1000));

	// Spawn TUI process in foreground
	console.log(`Connecting TUI to ws://localhost:${actualPort}...`);
	const tuiProcess = spawn(
		process.execPath,
		[
			"--import", "tsx",
			"--no-warnings",
			...(await getTsconfigPaths()),
			"src/cli.ts",
			"tui",
			"--agent", `ws://localhost:${actualPort}`,
		],
		{
			cwd: process.cwd(),
			stdio: "inherit",
			env: { ...process.env },
		},
	);

	tuiProcess.on("exit", (code) => {
		// TUI exited — shut down agent too
		agentProcess.kill("SIGINT");
		process.exit(code ?? 0);
	});

	// Forward signals
	process.on("SIGINT", () => {
		tuiProcess.kill("SIGINT");
		agentProcess.kill("SIGINT");
	});
}

/**
 * Legacy single-process demo loop.
 * Encrypts and decrypts within the same process.
 */
async function startLegacyLoop(options: CryptocodeOptions): Promise<void> {
	const mode: SecurityMode = options.securityMode ?? "lenient";

	let channel: DualChannel;

	if (options.userSeedUrl && options.agentSeedUrl) {
		const result = await initSession(options.userSeedUrl, options.agentSeedUrl);
		channel = result.channel;
	} else if (sessionExists()) {
		const result = await restoreSession();
		channel = result.channel;
	} else {
		console.error(
			"No session found. Provide seed URLs with --user-seed-url and --agent-seed-url,\n" +
				"or run 'cryptocode init' first.",
		);
		process.exit(1);
	}

	const otpSession = new OTPSession(channel, mode, {
		onAuthenticated: (instruction: string) => {
			console.log(`[OTP OK] Authenticated: ${instruction.slice(0, 80)}...`);
		},
		onUnauthenticated: (raw: Buffer, reason: string) => {
			console.log(`[OTP FAIL] ${reason}. Raw bytes: ${raw.length}`);
		},
		onSendToAgent: async (message: string) => {
			console.log(`→ Agent: ${message.slice(0, 100)}...`);
		},
	});

	console.log("\nCryptocode session active (legacy mode). Type messages (Ctrl+C to quit).\n");
	console.log(`  Security mode: ${mode}`);
	console.log(`  U→A pad remaining: ${channel.getUAPadRemaining()} bytes`);
	console.log(`  A→U pad remaining: ${channel.getAUPadRemaining()} bytes`);
	console.log();

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
				const encrypted = await otpSession.encryptOutgoing(input);
				const llmMessage = await otpSession.processIncoming(encrypted);

				if (llmMessage) {
					console.log(`  Agent received: ${llmMessage}`);
				} else {
					console.log("  [Message rejected — unauthenticated]");
				}

				const response = `Echo: ${input}`;
				const encResponse = await otpSession.encryptResponse(response);
				const decrypted = await otpSession.decryptResponse(encResponse);

				if (decrypted) {
					console.log(`  Agent response: ${decrypted}`);
				}

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

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const net = require("node:net");
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

async function getTsconfigPaths(): Promise<string[]> {
	// When running from the repo, tsx handles path resolution
	return [];
}
