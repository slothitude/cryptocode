/**
 * Agent server — headless process with LLM access.
 *
 * 1. Restores or creates a DualChannel from session state
 * 2. Creates a WireServer on the given port
 * 3. On USER_INSTRUCTION: decrypt → convertToLlmMessage → forward to LLM
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
	/** Optional event source (AgentSession or mock). If not provided, echoes back. */
	eventSource?: AgentEventSource;
}

/** Abstraction over pi-mono AgentSession for testability. */
export interface AgentEventSource {
	/** Subscribe to agent events. Returns unsubscribe function. */
	subscribe(fn: (event: Record<string, unknown>) => void): () => void;
	/** Send a prompt to the agent. */
	prompt(text: string): Promise<void>;
}

export async function startAgentServer(options: AgentServerOptions): Promise<WireServer> {
	const mode: SecurityMode = options.securityMode ?? "lenient";

	// Restore session
	const { channel } = await restoreSession();

	const server = new WireServer({
		port: options.port,
		channel,
		onInstruction: async (text, authenticated) => {
			const llmMessage = convertToLlmMessage(text, authenticated, mode);

			if (!llmMessage) {
				// Strict mode — message dropped
				return;
			}

			if (options.eventSource) {
				await options.eventSource.prompt(llmMessage);
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
			}

			// Save session state after each turn
			saveSession({
				version: 1,
				channels: {
					userToAgent: channel["userToAgent"].toState(),
					agentToUser: channel["agentToUser"].toState(),
				},
				createdAt: new Date().toISOString(),
			});
		},
	});

	// If an event source is provided, wire up its events to the server
	if (options.eventSource) {
		options.eventSource.subscribe(async (event) => {
			try {
				await server.sendAgentEvent(event);
			} catch {
				// Server may not be ready yet or client disconnected
			}
		});
	}

	await server.start();
	return server;
}
