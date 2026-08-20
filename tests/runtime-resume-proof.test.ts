import test from "node:test";
import assert from "node:assert/strict";
import {
	CONTINUATION_PROMPT,
	acceptContinuationCompactionProof,
	createContinuationRuntimeState,
	markAwaitingContinuationResumeStarted,
	settleAwaitingContinuationResumeFromAssistant,
	startContinuationCompaction,
} from "../extensions/continue/src/runtime.ts";

function createContext(idle = true) {
	let compactOptions;
	return {
		aborts: 0,
		get compactOptions() {
			return compactOptions;
		},
		ctx: {
			hasUI: false,
			ui: {
				notify() {},
				setStatus() {},
			},
			isIdle() {
				return idle;
			},
			abort() {
				this.owner.aborts++;
			},
			compact(options) {
				compactOptions = options;
			},
			owner: undefined,
		},
	};
}

function bindContext(owner) {
	owner.ctx.owner = owner;
	return owner.ctx;
}

function completeAndVerify(owner, ctx, runtime, eventId = "continue-1", compactionId = "compact-1") {
	owner.compactOptions.onComplete({});
	acceptContinuationCompactionProof(ctx, runtime, eventId, compactionId);
}

function verifyThenComplete(owner, ctx, runtime, eventId = "continue-1", compactionId = "compact-1") {
	acceptContinuationCompactionProof(ctx, runtime, eventId, compactionId);
	owner.compactOptions.onComplete({});
}

test("startContinuationCompaction sends resume only after owned compaction proof", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: "preserve blockers",
		trigger: undefined,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(started, true);
	assert.equal(owner.aborts, 0);
	assert.equal(runtime.compactionRunning, true);
	assert.equal(runtime.latestEvent?.source, "command-steer");
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.artifactStatus, "pending");
	assert.equal(owner.compactOptions.customInstructions, "preserve blockers");
	owner.compactOptions.onComplete({});
	assert.equal(runtime.compactionRunning, false);
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.compactionProof.status, "pending");
	assert.equal(runtime.latestEvent?.promptStatus, "pending");
	assert.equal(runtime.latestEvent?.resume.status, "not-requested");
	assert.deepEqual(continuations, []);
	acceptContinuationCompactionProof(ctx, runtime, "continue-1", "compact-1");
	assert.equal(runtime.latestEvent?.compactionProof.status, "verified");
	assert.equal(runtime.latestEvent?.promptStatus, "sent");
	assert.equal(runtime.latestEvent?.resume.status, "pending");
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
	assert.equal(markAwaitingContinuationResumeStarted(runtime), "continue-1");
	settleAwaitingContinuationResumeFromAssistant(runtime, {
		role: "assistant",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "text", text: "continuing" }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	});
	assert.equal(runtime.latestEvent?.status, "completed");
	assert.equal(runtime.latestEvent?.resume.status, "completed");
	assert.equal(runtime.activeEventId, undefined);
});

test("continuation leaves active-run cancellation to ctx.compact", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const compact = ctx.compact;
	ctx.compact = (options) => {
		owner.aborts += 1;
		compact.call(ctx, options);
	};
	const runtime = createContinuationRuntimeState();

	const started = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: () => {},
	});

	assert.equal(started, true);
	assert.equal(owner.aborts, 1);
	assert.equal(runtime.compactionRunning, true);
});

test("synchronous resume start proof survives verified dispatch ordering", () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: (prompt) => {
			continuations.push(prompt);
			assert.equal(markAwaitingContinuationResumeStarted(runtime), "continue-1");
		},
	});
	assert.equal(started, true);
	completeAndVerify(owner, ctx, runtime);
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
	assert.equal(runtime.latestEvent?.compactionProof.status, "verified");
	assert.equal(runtime.latestEvent?.promptStatus, "sent");
	assert.equal(runtime.latestEvent?.resume.status, "running");
	assert.equal(runtime.awaitingResumeEventId, "continue-1");
});

test("owned proof before compaction completion waits for completion before resume", () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(started, true);
	verifyThenComplete(owner, ctx, runtime);
	assert.equal(runtime.latestEvent?.compactionProof.status, "verified");
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
});

test("verified proof survives a delayed Already compacted callback", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(started, true);
	acceptContinuationCompactionProof(ctx, runtime, "continue-1", "compact-native");
	assert.deepEqual(continuations, []);
	owner.compactOptions.onError(new Error("Already compacted"));
	assert.equal(runtime.compactionRunning, false);
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.failureReason, undefined);
	assert.equal(runtime.latestEvent?.compactionProof.status, "verified");
	assert.equal(runtime.latestEvent?.resume.status, "pending");
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
	owner.compactOptions.onError(new Error("Already compacted"));
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
});

test("owned proof timeout fails closed without sending resume", async () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const failedEvents = [];
	const continuations = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
		onContinuationFailed: (eventId) => failedEvents.push(eventId),
		compactionProofTimeoutMs: 0,
	});
	assert.equal(started, true);
	owner.compactOptions.onComplete({});
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(continuations, []);
	assert.deepEqual(failedEvents, ["continue-1"]);
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.compactionProof.status, "failed");
	assert.equal(runtime.latestEvent?.promptStatus, "failed");
	assert.equal(runtime.latestEvent?.failureReason, "Pi did not report a saved package-owned continuation handoff before resume.");
});
