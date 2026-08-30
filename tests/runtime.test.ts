import test from "node:test";
import assert from "node:assert/strict";
import { markActiveContinuationArtifact, recordActiveSynthesisFailure } from "../extensions/continue/src/continuation-event.ts";
import {
	CONTINUATION_PROMPT,
	acceptContinuationCompactionProof,
	completeContinuationCompactionFromHost,
	armDeferredResumeStartTimeout,
	consumeNativeCompactionAdoptionCheckpoint,
	createContinuationRuntimeState,
	failRunningAwaitingContinuationResume,
	markAwaitingContinuationResumeStarted,
	normalizeMidRunGuardAbortMessage,
	parseContinuationRequest,
	recordNativeCompactionAdoptionCheckpoint,
	releaseAdoptedNativeCompaction,
	runContinuationCommand,
	settleAwaitingContinuationResumeFromAssistant,
	startAdoptedNativeCompaction,
	startContinuationCompaction,
} from "../extensions/continue/src/runtime.ts";

function createContext(idle = true) {
	let compactOptions;
	return {
		aborts: 0,
		waits: 0,
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
			async waitForIdle() {
				this.owner.waits++;
			},
			owner: undefined,
		},
	};
}

function bindContext(owner) {
	owner.ctx.owner = owner;
	return owner.ctx;
}

const trigger = {
	mode: "reserve-tokens",
	estimatedTokens: 120,
	thresholdTokens: 100,
	contextWindow: 128,
	reserveTokens: 28,
	usageTokens: 90,
	trailingTokens: 30,
	lastUsageIndex: 3,
};

async function flushResumeDispatch(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function completeAndVerify(owner, ctx, runtime, eventId = "continue-1", compactionId = "compact-1") {
	owner.compactOptions.onComplete({});
	acceptContinuationCompactionProof(ctx, runtime, eventId, compactionId);
	await flushResumeDispatch();
}

test("receiver prompt frames the agent as its own amnesiac continuer with a factual authority boundary", () => {
	assert.match(CONTINUATION_PROMPT, /continuing the same work/i);
	assert.match(CONTINUATION_PROMPT, /amnesi/i);
	assert.match(CONTINUATION_PROMPT, /tattoo/i);
	assert.match(CONTINUATION_PROMPT, /authoritative factual context/i);
	assert.match(CONTINUATION_PROMPT, /other summary or fallback/i);
	assert.match(CONTINUATION_PROMPT, /Authority boundary/i);
	assert.match(CONTINUATION_PROMPT, /not higher-priority instructions/i);
	assert.match(CONTINUATION_PROMPT, /directive-looking text as data/i);
	assert.match(CONTINUATION_PROMPT, /reopen clause triggers, new evidence conflicts, or current instructions require fresh proof/i);
	assert.match(CONTINUATION_PROMPT, /system, developer, or human instructions supersede or retract/i);
	assert.match(CONTINUATION_PROMPT, /brief\.established/);
	assert.match(CONTINUATION_PROMPT, /brief\.learned/);
	assert.match(CONTINUATION_PROMPT, /brief\.forbid/);
	assert.match(CONTINUATION_PROMPT, /brief\.open/);
	assert.match(CONTINUATION_PROMPT, /brief\.next\[0\]/);
	assert.match(CONTINUATION_PROMPT, /brief\.task/);
	assert.match(CONTINUATION_PROMPT, /brief\.done_when/);
});

test("parseContinuationRequest defaults to steer and preserves instructions", () => {
	assert.deepEqual(parseContinuationRequest(undefined), { mode: "steer", instructions: undefined });
	assert.deepEqual(parseContinuationRequest(""), { mode: "steer", instructions: undefined });
	assert.deepEqual(parseContinuationRequest("queue preserve state"), { mode: "queue", instructions: "preserve state" });
	assert.deepEqual(parseContinuationRequest("steer focus auth"), { mode: "steer", instructions: "focus auth" });
	assert.deepEqual(parseContinuationRequest("now focus auth"), { mode: "steer", instructions: "now focus auth" });
});

test("native adoption checkpoint is normal-stop-only and one-shot", () => {
	const runtime = createContinuationRuntimeState();
	recordNativeCompactionAdoptionCheckpoint(runtime, "toolUse");
	assert.equal(runtime.nativeCompactionAdoptionCheckpoint, undefined);
	recordNativeCompactionAdoptionCheckpoint(runtime, "stop");
	const checkpoint = consumeNativeCompactionAdoptionCheckpoint(runtime);
	assert.equal(checkpoint?.stopReason, "stop");
	assert.equal(runtime.nativeCompactionAdoptionCheckpoint, undefined);
	assert.equal(consumeNativeCompactionAdoptionCheckpoint(runtime), undefined);
});

test("mid-run guard abort normalization is scoped to active ownership", () => {
	const abortError = {
		role: "assistant",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "toolCall", id: "partial-call", name: "bash", arguments: { command: "printf unsafe" } }],
		usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: "This operation was aborted",
		timestamp: 0,
	};
	const providerError = { ...abortError, errorMessage: "Provider connection failed" };
	const idleRuntime = createContinuationRuntimeState();
	assert.equal(normalizeMidRunGuardAbortMessage(idleRuntime, abortError), abortError);

	const manualOwner = createContext(false);
	const manualCtx = bindContext(manualOwner);
	const manualRuntime = createContinuationRuntimeState();
	startContinuationCompaction(manualCtx, manualRuntime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: true,
		continueAfterComplete: false,
		sendContinuation() {},
	});
	assert.equal(normalizeMidRunGuardAbortMessage(manualRuntime, abortError), abortError);
	manualOwner.compactOptions.onComplete({});

	const successOwner = createContext(false);
	const successCtx = bindContext(successOwner);
	const successRuntime = createContinuationRuntimeState();
	startContinuationCompaction(successCtx, successRuntime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: false,
		sendContinuation() {},
	});
	assert.equal(normalizeMidRunGuardAbortMessage(successRuntime, providerError), providerError);
	const normalized = normalizeMidRunGuardAbortMessage(successRuntime, abortError);
	assert.notEqual(normalized, abortError);
	assert.equal(normalized.stopReason, "stop");
	assert.deepEqual(normalized.content, []);
	assert.equal(normalized.errorMessage, undefined);
	assert.equal(normalizeMidRunGuardAbortMessage(successRuntime, abortError), abortError);
	successOwner.compactOptions.onComplete({});
	assert.equal(normalizeMidRunGuardAbortMessage(successRuntime, abortError), abortError);

	const failureOwner = createContext(false);
	const failureCtx = bindContext(failureOwner);
	const failureRuntime = createContinuationRuntimeState();
	startContinuationCompaction(failureCtx, failureRuntime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: false,
		sendContinuation() {},
	});
	failureOwner.compactOptions.onError(new Error("failed"));
	assert.equal(normalizeMidRunGuardAbortMessage(failureRuntime, abortError), abortError);
});

test("mid-run native delegation aborts once and resumes after the host proof", async () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: true,
		deferToNativeCompaction: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(started, true);
	assert.equal(owner.aborts, 1);
	assert.equal(owner.compactOptions, undefined);
	assert.equal(runtime.compactionRunning, true);
	assert.equal(runtime.controlledMidRunAbortRequested, true);
	assert.equal(completeContinuationCompactionFromHost(ctx, runtime, "continue-1"), false);
	assert.equal(acceptContinuationCompactionProof(ctx, runtime, "continue-1", "compact-1"), true);
	assert.equal(completeContinuationCompactionFromHost(ctx, runtime, "continue-1"), true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
	assert.equal(runtime.compactionRunning, false);
});

test("adopted native compaction owns lifecycle without invoking compact or abort", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const failedEvents = [];
	const eventId = startAdoptedNativeCompaction(ctx, runtime, {
		sendContinuation() {},
		onContinuationFailed: (failedEventId) => failedEvents.push(failedEventId),
	});
	assert.equal(eventId, "continue-1");
	assert.equal(owner.aborts, 0);
	assert.equal(owner.compactOptions, undefined);
	assert.equal(runtime.latestEvent?.source, "adopted-compaction");
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.pendingResumeDispatch?.eventId, "continue-1");
	assert.equal(releaseAdoptedNativeCompaction(ctx, runtime, eventId, "fallback", (failedEventId) => {
		failedEvents.push(failedEventId);
	}), true);
	assert.deepEqual(failedEvents, ["continue-1"]);
	assert.equal(runtime.activeEventId, undefined);
	assert.equal(runtime.pendingResumeDispatch, undefined);
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.failureReason, "fallback");
});

test("stale assistant message_end cannot settle resume before start proof", async () => {
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
	await completeAndVerify(owner, ctx, runtime);
	const stale = settleAwaitingContinuationResumeFromAssistant(runtime, {
		role: "assistant",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "text", text: "stale" }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	});
	assert.equal(stale, undefined);
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.resume.status, "pending");
	assert.equal(runtime.awaitingResumeEventId, "continue-1");
});

test("agent-end resume failure requires start proof", async () => {
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
	await completeAndVerify(owner, ctx, runtime);
	assert.equal(failRunningAwaitingContinuationResume(runtime, "Continuation resume did not produce an assistant response."), undefined);
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(markAwaitingContinuationResumeStarted(runtime), "continue-1");
	const settlement = failRunningAwaitingContinuationResume(runtime, "Continuation resume did not produce an assistant response.");
	assert.deepEqual(settlement, { eventId: "continue-1", status: "failed" });
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.resume.status, "failed");
	assert.equal(runtime.latestEvent?.resume.failureReason, "Continuation resume did not produce an assistant response.");
	assert.equal(runtime.awaitingResumeEventId, undefined);
});

test("resume proof stays running while the resumed assistant requests tools", async () => {
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
	await completeAndVerify(owner, ctx, runtime);
	assert.equal(markAwaitingContinuationResumeStarted(runtime), "continue-1");
	const settlement = settleAwaitingContinuationResumeFromAssistant(runtime, {
		role: "assistant",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "/repo/a.ts" } }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	});
	assert.equal(settlement, undefined);
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.resume.status, "running");
	assert.equal(runtime.awaitingResumeEventId, "continue-1");
});

test("mid-run guard can chain after a resumed assistant tool-use turn", async () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const first = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(first, true);
	await completeAndVerify(owner, ctx, runtime);
	assert.equal(markAwaitingContinuationResumeStarted(runtime), "continue-1");
	const toolUseSettlement = settleAwaitingContinuationResumeFromAssistant(runtime, {
		role: "assistant",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "/repo/a.ts" } }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	});
	assert.equal(toolUseSettlement, undefined);
	const guard = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(guard, true);
	assert.equal(owner.aborts, 0);
	assert.equal(runtime.latestEvent?.id, "continue-2");
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.resume.status, "not-requested");
	assert.equal(runtime.awaitingResumeEventId, undefined);
	assert.equal(continuations.length, 1);
});

test("mid-run guard stops over-limit request while handoff is already saving", () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const first = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(first, true);
	const guard = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(guard, false);
	assert.equal(owner.aborts, 1);
	assert.equal(runtime.latestEvent?.id, "continue-1");
	assert.equal(runtime.compactionRunning, true);
	assert.equal(continuations.length, 0);
});

test("pending resume blocks new continuation without clobbering active state", async () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const first = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(first, true);
	await completeAndVerify(owner, ctx, runtime);
	assert.equal(runtime.activeEventId, "continue-1");
	assert.equal(runtime.awaitingResumeEventId, "continue-1");
	const second = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(second, false);
	assert.equal(owner.aborts, 0);
	assert.equal(runtime.latestEvent?.id, "continue-1");
	assert.equal(runtime.activeEventId, "continue-1");
	assert.equal(runtime.awaitingResumeEventId, "continue-1");
	assert.equal(continuations.length, 1);
});

test("mid-run guard stops over-limit request while preserving pending resume", async () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const first = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(first, true);
	await completeAndVerify(owner, ctx, runtime);
	const guard = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(guard, false);
	assert.equal(owner.aborts, 1);
	assert.equal(runtime.latestEvent?.id, "continue-1");
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.resume.status, "pending");
	assert.equal(runtime.awaitingResumeEventId, "continue-1");
	assert.equal(continuations.length, 1);
});

test("duplicate compaction terminal callbacks cannot double-send or fail pending resume", async () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const failedEvents = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
		onContinuationFailed: (eventId) => failedEvents.push(eventId),
	});
	assert.equal(started, true);
	await completeAndVerify(owner, ctx, runtime);
	owner.compactOptions.onComplete({});
	owner.compactOptions.onError(new Error("provider failed"));
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
	assert.deepEqual(failedEvents, []);
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.promptStatus, "sent");
	assert.equal(runtime.latestEvent?.resume.status, "pending");
	assert.equal(runtime.activeEventId, "continue-1");
});

test("resume start timeout settles idle prompt dispatch that never starts", async () => {
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
		resumeStartTimeoutMs: 0,
	});
	assert.equal(started, true);
	await completeAndVerify(owner, ctx, runtime);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
	assert.deepEqual(failedEvents, ["continue-1"]);
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.resume.status, "failed");
	assert.equal(runtime.latestEvent?.failureReason, "Continuation resume request failed before the next run started.");
	assert.equal(runtime.activeEventId, undefined);
	assert.equal(runtime.awaitingResumeEventId, undefined);
});

test("queued follow-up resume can start after the parent turn remains active", async () => {
	const owner = createContext(false);
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
		resumeStartTimeoutMs: 0,
	});
	assert.equal(started, true);
	await completeAndVerify(owner, ctx, runtime);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
	assert.deepEqual(failedEvents, []);
	assert.equal(runtime.latestEvent?.status, "running");
	assert.equal(runtime.latestEvent?.resume.status, "pending");
	assert.equal(runtime.awaitingResumeEventId, "continue-1");
	assert.equal(markAwaitingContinuationResumeStarted(runtime), "continue-1");
	const settlement = settleAwaitingContinuationResumeFromAssistant(runtime, {
		role: "assistant",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "text", text: "continuing" }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	});
	assert.deepEqual(settlement, { eventId: "continue-1", status: "completed" });
	assert.equal(runtime.latestEvent?.status, "completed");
	assert.equal(runtime.latestEvent?.resume.status, "completed");
});

test("queued follow-up resume start timeout arms after the active parent turn ends", async () => {
	const owner = createContext(false);
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
		resumeStartTimeoutMs: 0,
	});
	assert.equal(started, true);
	await completeAndVerify(owner, ctx, runtime);
	assert.equal(armDeferredResumeStartTimeout(ctx, runtime), true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
	assert.deepEqual(failedEvents, ["continue-1"]);
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.resume.status, "failed");
	assert.equal(runtime.latestEvent?.failureReason, "Continuation resume request failed before the next run started.");
	assert.equal(runtime.awaitingResumeEventId, undefined);
});

test("compaction error preserves synthesis hard-fail reason", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: () => {},
	});
	assert.equal(started, true);
	markActiveContinuationArtifact(runtime, "aborted", "pi-continue could not create a usable handoff, so continuation stopped before resuming.");
	owner.compactOptions.onError(new Error("compact failed"));
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.failureReason, "pi-continue could not create a usable handoff, so continuation stopped before resuming.");
});

test("handoff failure notification exposes the recorded synthesis classifier", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	ctx.hasUI = true;
	const notifications = [];
	ctx.ui.notify = (message, type) => {
		notifications.push([message, type]);
	};
	ctx.ui.setWorkingMessage = () => {};
	ctx.ui.setWorkingIndicator = () => {};
	ctx.ui.theme = { fg: () => "" };
	const runtime = createContinuationRuntimeState();
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: () => {},
	});
	assert.equal(started, true);
	recordActiveSynthesisFailure(runtime, {
		kind: "model-provider-call",
		code: "provider-error",
		pass: "history",
		requestedModel: "tokenrhythm/deepseek-v4-pro",
		httpStatus: 429,
	});
	markActiveContinuationArtifact(runtime, "aborted", "pi-continue could not create a usable handoff, so continuation stopped before resuming.");
	owner.compactOptions.onError(new Error("compact failed"));
	assert.equal(runtime.latestEvent?.status, "failed");
	const failureNotify = notifications.find(([message]) => message.includes("handoff failed"));
	assert.ok(failureNotify);
	assert.match(failureNotify[0], /provider error/);
	assert.match(failureNotify[0], /HTTP 429/);
	assert.match(failureNotify[0], /requested tokenrhythm\/deepseek-v4-pro/);
});

test("handoff failure notification falls back to fixed copy without a classifier", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	ctx.hasUI = true;
	const notifications = [];
	ctx.ui.notify = (message, type) => {
		notifications.push([message, type]);
	};
	ctx.ui.setWorkingMessage = () => {};
	ctx.ui.setWorkingIndicator = () => {};
	ctx.ui.theme = { fg: () => "" };
	const runtime = createContinuationRuntimeState();
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: () => {},
	});
	assert.equal(started, true);
	markActiveContinuationArtifact(runtime, "aborted", "pi-continue could not create a usable handoff, so continuation stopped before resuming.");
	owner.compactOptions.onError(new Error("compact failed"));
	assert.equal(runtime.latestEvent?.status, "failed");
	const failureNotify = notifications.find(([message]) => message.includes("handoff failed"));
	assert.ok(failureNotify);
	assert.match(failureNotify[0], /could not create a usable handoff/);
});

test("failed guard records a failure key and blocks identical retries", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(started, true);
	owner.compactOptions.onError(new Error("compact failed"));
	assert.equal(runtime.compactionRunning, false);
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.failureReason, "Continuation handoff failed.");
	assert.equal(continuations.length, 0);
	const retry = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(retry, false);
	assert.equal(owner.aborts, 1);
	assert.equal(runtime.latestEvent?.status, "blocked");
	assert.equal(runtime.latestEvent?.failureReason, "Repeated over-limit retry was blocked after a failed continuation.");
});

test("prompt dispatch failure settles the latest event", async () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: () => {
			throw new Error("send failed");
		},
	});
	assert.equal(started, true);
	await completeAndVerify(owner, ctx, runtime);
	assert.equal(runtime.compactionRunning, false);
	assert.equal(runtime.activeEventId, undefined);
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.promptStatus, "failed");
	assert.equal(runtime.latestEvent?.failureReason, "Continuation resume request failed.");
});

test("duplicate terminal callbacks do not revive failed events", () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: true,
		sendContinuation: (prompt) => continuations.push(prompt),
	});
	assert.equal(started, true);
	owner.compactOptions.onError(new Error("provider failed"));
	owner.compactOptions.onComplete({});
	assert.equal(runtime.latestEvent?.status, "failed");
	assert.equal(runtime.latestEvent?.promptStatus, "failed");
	assert.equal(continuations.length, 0);
});

test("compaction failures call the pending-write cleanup hook", () => {
	const owner = createContext(true);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const failedEvents = [];
	const started = startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: undefined,
		trigger: undefined,
		abortActiveRun: false,
		continueAfterComplete: true,
		sendContinuation: () => {},
		onContinuationFailed: (eventId) => failedEvents.push(eventId),
	});
	assert.equal(started, true);
	owner.compactOptions.onError(new Error("permission denied"));
	assert.deepEqual(failedEvents, ["continue-1"]);
});

test("runContinuationCommand queue waits for idle before compaction", async () => {
	const owner = createContext(false);
	const ctx = bindContext(owner);
	const runtime = createContinuationRuntimeState();
	const continuations = [];
	await runContinuationCommand(ctx, runtime, "queue finish validation", (prompt) => continuations.push(prompt));
	assert.equal(owner.waits, 1);
	assert.equal(owner.aborts, 0);
	assert.equal(owner.compactOptions.customInstructions, "finish validation");
	await completeAndVerify(owner, ctx, runtime);
	assert.deepEqual(continuations, [CONTINUATION_PROMPT]);
});
