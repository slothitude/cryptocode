import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SessionState } from "./types.js";

/**
 * Override for the config directory. Used for testing.
 * When set, all functions use this directory instead of ~/.cryptocode.
 */
let configDirOverride: string | undefined;

/**
 * Set a custom config directory (for testing).
 * Pass undefined to reset to default behavior.
 */
export function setConfigDirOverride(dir: string | undefined): void {
	configDirOverride = dir;
}

/** Get the config directory path. */
export function getConfigDir(): string {
	return configDirOverride ?? path.join(os.homedir(), ".cryptocode");
}

/** Get the session file path. */
export function getSessionFilePath(): string {
	return path.join(getConfigDir(), "session.json");
}

/** Ensure the config directory exists. */
function ensureConfigDir(): void {
	const dir = getConfigDir();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/** Save session state to ~/.cryptocode/session.json. */
export function saveSession(state: SessionState): void {
	ensureConfigDir();
	const json = JSON.stringify(state, null, 2);
	fs.writeFileSync(getSessionFilePath(), json, "utf-8");
}

/** Load session state from ~/.cryptocode/session.json. Throws if not found. */
export function loadSession(): SessionState {
	const filePath = getSessionFilePath();
	if (!fs.existsSync(filePath)) {
		throw new Error(
			`No session found at ${filePath}. Run 'cryptocode init' first.`,
		);
	}
	const json = fs.readFileSync(filePath, "utf-8");
	const state = JSON.parse(json) as SessionState;
	if (state.version !== 1) {
		throw new Error(`Unsupported session version: ${state.version}`);
	}
	return state;
}

/** Check if a session already exists. */
export function sessionExists(): boolean {
	return fs.existsSync(getSessionFilePath());
}

/** Delete the session file. */
export function deleteSession(): void {
	const filePath = getSessionFilePath();
	if (fs.existsSync(filePath)) {
		fs.unlinkSync(filePath);
	}
}
