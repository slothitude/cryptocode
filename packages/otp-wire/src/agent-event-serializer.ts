import type { AgentEventEnvelope } from "./types.js";

/**
 * Serialize a pi-mono AgentSessionEvent to an AgentEventEnvelope.
 * Uses JSON-safe serialization — all pi-mono-specific types are flattened.
 */
export function serializeAgentEvent(event: Record<string, unknown>): AgentEventEnvelope {
	return {
		eventType: event.type as string,
		data: event,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Deserialize an AgentEventEnvelope back to its original event shape.
 */
export function deserializeAgentEvent(envelope: AgentEventEnvelope): Record<string, unknown> {
	return envelope.data as Record<string, unknown>;
}
