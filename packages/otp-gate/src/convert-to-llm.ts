import type { SecurityMode } from "@cryptocode/otp-core";

/**
 * Marker strings prepended to messages before they reach the LLM.
 * The system prompt instructs the LLM to only act on [AUTHENTICATED] messages.
 */
export const AUTHENTICATED_MARKER = "[AUTHENTICATED]";
export const UNAUTHENTICATED_MARKER = "[UNAUTHENTICATED]";

/**
 * Convert a decrypted result into an LLM-consumable message.
 * Applies security-mode-specific handling.
 */
export function convertToLlmMessage(
	instruction: string,
	authenticated: boolean,
	mode: SecurityMode,
): string | null {
	const marker = authenticated
		? AUTHENTICATED_MARKER
		: UNAUTHENTICATED_MARKER;

	if (authenticated) {
		return `${marker} ${instruction}`;
	}

	switch (mode) {
		case "strict":
			// Silently drop — return null to indicate "don't send to LLM"
			return null;
		case "lenient":
			// Mark and send — system prompt tells LLM to ignore
			return `${marker} <unauthenticated input — ignore>`;
		case "audit":
			// Pass through with marker for logging/analysis
			return `${marker} ${instruction}`;
		default:
			return null;
	}
}
