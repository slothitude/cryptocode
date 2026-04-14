/**
 * Agent server — headless process with LLM access.
 *
 * 1. Restores or creates a DualChannel from session state
 * 2. Creates a WireServer on the given port
 * 3. On USER_INSTRUCTION: decrypt → convertToLlmMessage → forward to AgentSession
 * 4. On agent events: serialize → encrypt → send as AGENT_EVENT frame
 * 5. Saves session state after each turn
 */
import { restoreSession } from "./core/session-init.js";
import { WireServer } from "@cryptocode/otp-wire";
import { convertToLlmMessage, OTP_SYSTEM_PROMPT_ADDON } from "@cryptocode/otp-gate";
import { saveSession } from "@cryptocode/otp-core";
import type { SecurityMode } from "@cryptocode/otp-core";

export interface AgentServerOptions {
	/** Port to listen on. */
	port: number;
	/** Security mode (default: lenient). */
	securityMode?: SecurityMode;
	/** Use echo mode instead of real AgentSession (for testing without API key). */
	echo?: boolean;
}

export async function startAgentServer(options: AgentServerOptions): Promise<WireServer> {
	const mode: SecurityMode = options.securityMode ?? "lenient";

	// Restore session
	const { channel } = await restoreSession();

	// Create real agent session unless echo mode.
	// Dynamic import required: pi-coding-agent is ESM, this file is CJS.
	let agentSession: {
		prompt(text: string): Promise<void>;
		subscribe(listener: (event: { type: string }) => void): () => void;
		readonly systemPrompt: string;
		readonly agent: { state: { systemPrompt: string } };
	} | null = null;

	if (!options.echo) {
		try {
			const { createAgentSession } = await import("@mariozechner/pi-coding-agent");
			const { session } = await createAgentSession();
			agentSession = session;

			// Append OTP system prompt addon via mutable agent state
			session.agent.state.systemPrompt =
				session.systemPrompt + "\n\n" + OTP_SYSTEM_PROMPT_ADDON;

			console.log("Agent session created with OTP system prompt");
		} catch (err) {
			console.error(
				"Failed to create agent session, falling back to echo mode:",
				err instanceof Error ? err.message : err,
			);
			agentSession = null;
		}
	}

	const server = new WireServer({
		port: options.port,
		channel,
		onInstruction: async (text, authenticated) => {
			const llmMessage = convertToLlmMessage(text, authenticated, mode);

			if (!llmMessage) {
				// Strict mode — message dropped
				return;
			}

			if (agentSession) {
				await agentSession.prompt(llmMessage);
			} else {
				// Echo mode — send back the decrypted text as agent events
				await server.sendAgentEvent({ type: "turn_start" });
				await server.sendAgentEvent({
					type: "message_start",
					message: { role: "assistant" },
				});
				await server.sendAgentEvent({
					type: "message_update",
					message: { role: "assistant", content: llmMessage },
				});
				await server.sendAgentEvent({
					type: "message_end",
					message: { role: "assistant", content: llmMessage },
				});
				await server.sendAgentEvent({
					type: "turn_end",
					message: { role: "assistant", content: llmMessage },
					toolResults: [],
				});
				await server.sendAgentEvent({ type: "agent_end", messages: [] });

				// Save session state after each echo turn
				saveSession({
					version: 1,
					channels: {
						userToAgent: channel["userToAgent"].toState(),
						agentToUser: channel["agentToUser"].toState(),
					},
					createdAt: new Date().toISOString(),
				});
			}
		},
	});

	// Subscribe to agent events and forward through wire protocol
	if (agentSession) {
		agentSession.subscribe((event) => {
			server.sendAgentEvent(event as Record<string, unknown>).catch(() => {
				// Client may have disconnected
			});

			// Save session state after each full agent turn
			if (event.type === "agent_end") {
				saveSession({
					version: 1,
					channels: {
						userToAgent: channel["userToAgent"].toState(),
						agentToUser: channel["agentToUser"].toState(),
					},
					createdAt: new Date().toISOString(),
				});
			}
		});
	}

	await server.start();
	return server;
}
