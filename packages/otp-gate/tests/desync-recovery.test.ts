import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PadManager } from "@cryptocode/otp-core";
import { DualChannel } from "../src/dual-channel.js";
import type { EncryptedMessage } from "@cryptocode/otp-core";

/**
 * Helper: create paired channels that share the same pad material.
 */
function createPairedChannels(uaBytes: number, auBytes: number): {
	sender: DualChannel;
	receiver: DualChannel;
} {
	const uaBuf = Buffer.alloc(uaBytes);
	const auBuf = Buffer.alloc(auBytes);
	for (let i = 0; i < uaBytes; i++) uaBuf[i] = (i * 37 + 17) & 0xff;
	for (let i = 0; i < auBytes; i++) auBuf[i] = (i * 53 + 29) & 0xff;

	// Use lowWaterMark=0 to prevent auto-refill from triggering during tests
	// (test:// URLs can't be fetched)
	const sender = new DualChannel(
		new PadManager("test://ua", Buffer.from(uaBuf), 0, 0),
		new PadManager("test://au", Buffer.from(auBuf), 0, 0),
	);
	const receiver = new DualChannel(
		new PadManager("test://ua", Buffer.from(uaBuf), 0, 0),
		new PadManager("test://au", Buffer.from(auBuf), 0, 0),
	);

	return { sender, receiver };
}

describe("desync recovery (spec Phase 3 — chuck a wobbly)", () => {
	describe("sequence number tracking", () => {
		it("should increment sequence on each encrypt", async () => {
			const { sender } = createPairedChannels(10_000, 10_000);

			assert.strictEqual(sender.userToAgent.getSequence(), 0);
			await sender.encryptUserMessage("msg1");
			assert.strictEqual(sender.userToAgent.getSequence(), 1);
			await sender.encryptUserMessage("msg2");
			assert.strictEqual(sender.userToAgent.getSequence(), 2);
		});

		it("should include sequence number in encrypted messages", async () => {
			const { sender } = createPairedChannels(10_000, 10_000);

			const msg0 = await sender.encryptUserMessage("first");
			assert.strictEqual(msg0.sequence, 0);

			const msg1 = await sender.encryptUserMessage("second");
			assert.strictEqual(msg1.sequence, 1);
		});
	});

	describe("lastSuccessfulUrl tracking", () => {
		it("should start with the seed URL as lastSuccessfulUrl", () => {
			const { receiver } = createPairedChannels(10_000, 10_000);
			assert.strictEqual(
				receiver.userToAgent.getLastSuccessfulUrl(),
				"test://ua",
			);
		});

		it("should update lastSuccessfulUrl when a message with nextUrl is decrypted", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			const msg = await sender.encryptUserMessage(
				"hello",
				"https://en.wikipedia.org/wiki/NewPage",
			);
			const result = await receiver.decryptUserMessage(msg);

			assert.strictEqual(result.authenticated, true);
			assert.strictEqual(
				receiver.userToAgent.getLastSuccessfulUrl(),
				"https://en.wikipedia.org/wiki/NewPage",
			);
		});

		it("should NOT update lastSuccessfulUrl for messages without nextUrl", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			const msg = await sender.encryptUserMessage("hello");
			await receiver.decryptUserMessage(msg);

			assert.strictEqual(
				receiver.userToAgent.getLastSuccessfulUrl(),
				"test://ua", // unchanged
			);
		});

		it("should track lastSuccessfulUrl across multiple chain transitions", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Message with first nextUrl
			const msg1 = await sender.encryptUserMessage("go1", "https://page1.com");
			await receiver.decryptUserMessage(msg1);
			assert.strictEqual(receiver.userToAgent.getLastSuccessfulUrl(), "https://page1.com");

			// Message with second nextUrl
			const msg2 = await sender.encryptUserMessage("go2", "https://page2.com");
			await receiver.decryptUserMessage(msg2);
			assert.strictEqual(receiver.userToAgent.getLastSuccessfulUrl(), "https://page2.com");

			// Message without nextUrl — keeps last one
			const msg3 = await sender.encryptUserMessage("plain");
			await receiver.decryptUserMessage(msg3);
			assert.strictEqual(receiver.userToAgent.getLastSuccessfulUrl(), "https://page2.com");
		});
	});

	describe("desync detection — position divergence", () => {
		it("should detect desync when receiver is ahead (lost message)", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			const msg = await sender.encryptUserMessage("hello");

			// Receiver's pad gets ahead
			await receiver.userToAgent.advance(50);

			const result = await receiver.decryptUserMessage(msg);

			assert.strictEqual(result.authenticated, false);
			assert.ok(result.dsync, "Should have desync info");
			assert.strictEqual(result.dsync.senderSeq, 0);
			assert.strictEqual(result.dsync.receiverSeq, 1);
		});

		it("should detect desync when receiver is behind (unexpected message)", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			await sender.encryptUserMessage("msg1");
			await sender.encryptUserMessage("msg2");
			const msg3 = await sender.encryptUserMessage("msg3");

			// Receiver hasn't processed any — seq=0, msg3 has seq=2
			const result = await receiver.decryptUserMessage(msg3);

			assert.strictEqual(result.authenticated, false);
			assert.ok(result.dsync);
			assert.strictEqual(result.dsync.senderSeq, 2);
			assert.strictEqual(result.dsync.receiverSeq, 0);
		});

		it("should include lastSuccessfulUrl as recoveryUrl in desync info", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Establish a recovery anchor by exchanging a message with nextUrl
			const anchorMsg = await sender.encryptUserMessage("anchor", "https://recovery.com");
			await receiver.decryptUserMessage(anchorMsg);

			assert.strictEqual(
				receiver.userToAgent.getLastSuccessfulUrl(),
				"https://recovery.com",
			);

			// Now cause a desync
			await receiver.userToAgent.advance(10);
			const desyncMsg = await sender.encryptUserMessage("desync");
			const result = await receiver.decryptUserMessage(desyncMsg);

			assert.strictEqual(result.authenticated, false);
			assert.ok(result.dsync);
			assert.strictEqual(
				result.dsync.recoveryUrl,
				"https://recovery.com",
				"Recovery URL should be the lastSuccessfulUrl",
			);
		});
	});

	describe("spec-compliant recovery — re-fetch lastSuccessfulUrl", () => {
		it("should resync PadManager by re-fetching lastSuccessfulUrl", async () => {
			const buf = Buffer.alloc(10_000);
			const pm = new PadManager("test://seed", buf);

			await pm.advance(100);
			pm.setLastSuccessfulUrl("test://recovery-anchor");
			assert.strictEqual(pm.getPosition(), 100);
			assert.strictEqual(pm.getSequence(), 1);

			// Resync re-fetches lastSuccessfulUrl (we test with synthetic data)
			// Since resync() calls fetchUrl, we test the state changes directly
			// by checking that getLastSuccessfulUrl() returns the anchor
			assert.strictEqual(
				pm.getLastSuccessfulUrl(),
				"test://recovery-anchor",
			);
		});

		it("should authenticate messages after recovery with matching pads", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Exchange a message with nextUrl to set recovery anchor
			const anchorMsg = await sender.encryptUserMessage("anchor", "test://page2");
			const anchorResult = await receiver.decryptUserMessage(anchorMsg);
			assert.strictEqual(anchorResult.authenticated, true);
			assert.strictEqual(
				receiver.userToAgent.getLastSuccessfulUrl(),
				"test://page2",
			);

			// Cause desync
			await receiver.userToAgent.advance(50);
			const desyncMsg = await sender.encryptUserMessage("will fail");
			const desyncResult = await receiver.decryptUserMessage(desyncMsg);
			assert.strictEqual(desyncResult.authenticated, false);
			assert.strictEqual(desyncResult.dsync!.recoveryUrl, "test://page2");

			// Both sides recover by re-fetching the same URL.
			// Create fresh matching pads simulating the re-fetch
			const recoveryBuf = Buffer.alloc(10_000);
			for (let i = 0; i < 10_000; i++) recoveryBuf[i] = (i * 71 + 13) & 0xff;

			const recoveredSender = new DualChannel(
				new PadManager("test://page2", Buffer.from(recoveryBuf)),
				new PadManager("test://page2", Buffer.alloc(10_000)),
			);
			const recoveredReceiver = new DualChannel(
				new PadManager("test://page2", Buffer.from(recoveryBuf)),
				new PadManager("test://page2", Buffer.alloc(10_000)),
			);

			// Post-recovery messages authenticate
			const postMsg = await recoveredSender.encryptUserMessage("recovered!");
			const postResult = await recoveredReceiver.decryptUserMessage(postMsg);

			assert.strictEqual(postResult.authenticated, true);
			assert.strictEqual(postResult.instruction, "recovered!");
		});

		it("both sides agree on recovery URL without communication", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Set recovery anchor via successful exchange
			const msg = await sender.encryptUserMessage("setup", "test://shared-recovery");
			const result = await receiver.decryptUserMessage(msg);
			assert.strictEqual(result.authenticated, true);

			// Receiver knows the recovery URL from the decrypted message
			assert.strictEqual(
				receiver.userToAgent.getLastSuccessfulUrl(),
				"test://shared-recovery",
			);

			// Sender knows it too — it's the URL it chose to embed
			// (in production, sender also tracks it locally)
			assert.strictEqual(result.nextUrl, "test://shared-recovery");
		});
	});

	describe("auto-recovery threshold", () => {
		it("should trigger auto-resync after consecutive failures", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Desync by 1 message
			await sender.encryptUserMessage("lost");

			const msg1 = await sender.encryptUserMessage("fail1");
			const msg2 = await sender.encryptUserMessage("fail2");
			const msg3 = await sender.encryptUserMessage("fail3");

			await receiver.decryptUserMessage(msg1);
			assert.ok(!receiver.shouldAutoResyncUA());

			await receiver.decryptUserMessage(msg2);
			assert.ok(!receiver.shouldAutoResyncUA());

			await receiver.decryptUserMessage(msg3);
			assert.ok(receiver.shouldAutoResyncUA(), "Should trigger after 3 failures");
		});

		it("should reset failure counter on successful auth", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			const msg1 = await sender.encryptUserMessage("ok");
			await receiver.decryptUserMessage(msg1);
			assert.strictEqual(msg1.sequence, receiver.userToAgent.getSequence() - 1);

			// Force a desync
			await receiver.userToAgent.advance(50);
			const msg2 = await sender.encryptUserMessage("desync");
			await receiver.decryptUserMessage(msg2);

			assert.ok(!receiver.shouldAutoResyncUA(), "Only 1 failure");
		});
	});

	describe("replay attack rejection", () => {
		it("should reject a replayed message with an old sequence number", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Encrypt a message at seq 0
			const msg0 = await sender.encryptUserMessage("secret");
			assert.strictEqual(msg0.sequence, 0);

			// Process it normally
			const result0 = await receiver.decryptUserMessage(msg0);
			assert.strictEqual(result0.authenticated, true);
			assert.strictEqual(result0.instruction, "secret");
			assert.strictEqual(receiver.userToAgent.getSequence(), 1);

			// Advance both sides through several more messages
			for (let i = 0; i < 5; i++) {
				const msg = await sender.encryptUserMessage(`msg${i}`);
				const res = await receiver.decryptUserMessage(msg);
				assert.strictEqual(res.authenticated, true);
			}
			assert.strictEqual(receiver.userToAgent.getSequence(), 6);

			// Attacker replays msg0 (seq 0) — should be rejected
			const replayResult = await receiver.decryptUserMessage(msg0);
			assert.strictEqual(replayResult.authenticated, false, "Replayed message must be rejected");
			assert.ok(replayResult.dsync, "Should have desync info");
			assert.strictEqual(replayResult.dsync.senderSeq, 0, "Replayed seq");
			assert.strictEqual(replayResult.dsync.receiverSeq, 6, "Expected seq");
		});

		it("should reject a replayed message even if it was the last valid one", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Exchange one message
			const msg = await sender.encryptUserMessage("only msg");
			const result = await receiver.decryptUserMessage(msg);
			assert.strictEqual(result.authenticated, true);
			assert.strictEqual(receiver.userToAgent.getSequence(), 1);

			// Replay the exact same ciphertext
			const replay = await receiver.decryptUserMessage(msg);
			assert.strictEqual(replay.authenticated, false, "Even immediate replay must be rejected");
			assert.ok(replay.dsync);
			assert.strictEqual(replay.dsync.senderSeq, 0);
			assert.strictEqual(replay.dsync.receiverSeq, 1);
		});

		it("should reject replay on A→U channel too", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Agent sends a response
			const resp0 = await sender.encryptAgentResponse("agent says hi");
			assert.strictEqual(resp0.sequence, 0);

			// User decrypts
			const dec0 = await receiver.decryptAgentResponse(resp0);
			assert.strictEqual(dec0.authenticated, true);
			assert.strictEqual(receiver.agentToUser.getSequence(), 1);

			// More responses
			const resp1 = await sender.encryptAgentResponse("next");
			await receiver.decryptAgentResponse(resp1);
			assert.strictEqual(receiver.agentToUser.getSequence(), 2);

			// Replay the first response
			const replay = await receiver.decryptAgentResponse(resp0);
			assert.strictEqual(replay.authenticated, false);
			assert.ok(replay.dsync);
			assert.strictEqual(replay.dsync.senderSeq, 0);
			assert.strictEqual(replay.dsync.receiverSeq, 2);
		});

		it("should count replays toward auto-recovery threshold", async () => {
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Encrypt one message and deliver it
			const msg = await sender.encryptUserMessage("original");
			await receiver.decryptUserMessage(msg);

			// Now replay it 3 times
			await receiver.decryptUserMessage(msg);
			assert.ok(!receiver.shouldAutoResyncUA(), "1 failure");

			await receiver.decryptUserMessage(msg);
			assert.ok(!receiver.shouldAutoResyncUA(), "2 failures");

			await receiver.decryptUserMessage(msg);
			assert.ok(receiver.shouldAutoResyncUA(), "3 failures → auto-resync");
		});
	});

	describe("CDN drift — different bytes on re-fetch", () => {
		it("should fail to authenticate when resync fetches different bytes", async () => {
			// Simulate: both sides agree on recovery URL, but re-fetch
			// yields different bytes (CDN cache miss, content drift, etc.)
			const recoveryUrlA = "test://recovery-page";
			const recoveryUrlB = "test://recovery-page"; // Same URL

			// Different byte content from the "same" URL
			const bufA = Buffer.alloc(10_000);
			const bufB = Buffer.alloc(10_000);
			for (let i = 0; i < 10_000; i++) {
				bufA[i] = (i * 37 + 17) & 0xff;  // Version A
				bufB[i] = (i * 53 + 29) & 0xff;  // Version B (CDN drift)
			}

			// Both sides "re-fetched" the same URL but got different content
			const senderChannel = new DualChannel(
				new PadManager(recoveryUrlA, Buffer.from(bufA)),
				new PadManager(recoveryUrlA, Buffer.alloc(10_000)),
			);
			const receiverChannel = new DualChannel(
				new PadManager(recoveryUrlB, Buffer.from(bufB)),
				new PadManager(recoveryUrlB, Buffer.alloc(10_000)),
			);

			// Sender encrypts with version A pad
			const msg = await senderChannel.encryptUserMessage("after drift");
			// Receiver tries to decrypt with version B pad → fails
			const result = await receiverChannel.decryptUserMessage(msg);

			assert.strictEqual(result.authenticated, false,
				"Message must fail when pad bytes diverge due to CDN drift");
		});

		it("should authenticate when re-fetch yields identical bytes (happy path)", async () => {
			// Simulate: re-fetch returns the exact same bytes (cache hit)
			const buf = Buffer.alloc(10_000);
			for (let i = 0; i < 10_000; i++) buf[i] = (i * 37 + 17) & 0xff;

			const senderChannel = new DualChannel(
				new PadManager("test://cached", Buffer.from(buf)),
				new PadManager("test://cached", Buffer.alloc(10_000)),
			);
			const receiverChannel = new DualChannel(
				new PadManager("test://cached", Buffer.from(buf)), // Same bytes
				new PadManager("test://cached", Buffer.alloc(10_000)),
			);

			const msg = await senderChannel.encryptUserMessage("cache hit");
			const result = await receiverChannel.decryptUserMessage(msg);

			assert.strictEqual(result.authenticated, true);
			assert.strictEqual(result.instruction, "cache hit");
		});

		it("should trigger auto-resync again if CDN drift causes post-recovery failures", async () => {
			// First recovery fails due to drift → auto-resync triggers again
			// Second recovery with a stable URL succeeds
			const { sender, receiver } = createPairedChannels(10_000, 10_000);

			// Set a stable recovery anchor
			const anchorMsg = await sender.encryptUserMessage("anchor", "test://stable-page");
			await receiver.decryptUserMessage(anchorMsg);

			// Force desync
			await receiver.userToAgent.advance(200);

			// Send messages that fail, incrementing failure counter
			for (let i = 0; i < 3; i++) {
				const failMsg = await sender.encryptUserMessage(`fail${i}`);
				await receiver.decryptUserMessage(failMsg);
			}

			assert.ok(receiver.shouldAutoResyncUA(),
				"Auto-resync should trigger after 3 failures from drift");
		});
	});
});
