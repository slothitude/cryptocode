import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	saveSession,
	loadSession,
	sessionExists,
	deleteSession,
	getConfigDir,
	getSessionFilePath,
	setConfigDirOverride,
} from "../src/session-store.js";
import type { SessionState } from "../src/types.js";

let tmpDir: string;

function setupTempHome(): string {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cryptocode-test-"));
	setConfigDirOverride(path.join(tmpDir, ".cryptocode"));
	return tmpDir;
}

function cleanupTempHome(): void {
	setConfigDirOverride(undefined);
	if (tmpDir) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

function makeTestState(): SessionState {
	return {
		version: 1,
		channels: {
			userToAgent: {
				seedUrl: "https://en.wikipedia.org/wiki/Test1",
				position: 100,
				currentUrl: "https://en.wikipedia.org/wiki/Test1",
				bufferHash: "abc123",
				lowWaterMark: 10240,
			},
			agentToUser: {
				seedUrl: "https://en.wikipedia.org/wiki/Test2",
				position: 200,
				currentUrl: "https://en.wikipedia.org/wiki/Test2",
				bufferHash: "def456",
				lowWaterMark: 10240,
			},
		},
		createdAt: "2026-04-14T10:00:00Z",
	};
}

describe("session-store", () => {
	beforeEach(() => {
		setupTempHome();
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it("should save and load a session", () => {
		const state = makeTestState();
		saveSession(state);

		assert.ok(sessionExists());
		const loaded = loadSession();
		assert.deepStrictEqual(loaded, state);
	});

	it("should report no session when none exists", () => {
		assert.ok(!sessionExists());
	});

	it("should throw when loading non-existent session", () => {
		assert.throws(() => loadSession(), /No session found/);
	});

	it("should delete a session", () => {
		saveSession(makeTestState());
		assert.ok(sessionExists());

		deleteSession();
		assert.ok(!sessionExists());
	});

	it("should reject unsupported version", () => {
		const badState = { ...makeTestState(), version: 99 };
		const dir = getConfigDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			getSessionFilePath(),
			JSON.stringify(badState),
		);

		assert.throws(() => loadSession(), /Unsupported session version/);
	});
});
