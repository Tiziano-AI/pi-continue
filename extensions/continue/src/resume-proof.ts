import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_PROMPT, SHAKE_CONTINUATION_PROMPT } from "./continuation-prompt.ts";
import {
	finishContinuationEvent,
	isActiveRunningContinuationEvent,
	markContinuationCompactionProofFailed,
	markContinuationCompactionProofVerified,
	markContinuationPromptSent,
	markContinuationResumePending,
} from "./continuation-event.ts";
import type { ContinuationEventStore } from "./types.ts";
import { settleWorkingVisuals, updateWorkingVisuals } from "./working-ui.ts";

export const PROMPT_DISPATCH_FAILURE = "Continuation resume request failed.";
export const RESUME_START_TIMEOUT_FAILURE = "Continuation resume request failed before the next run started.";
export const COMPACTION_PROOF_TIMEOUT_FAILURE = "Pi did not report a saved package-owned continuation handoff before resume.";
export const NATIVE_COMPACTION_FALLBACK_FAILURE = "Pi saved a native compaction instead of a package-owned continuation handoff.";
export const INVALID_COMPACTION_PROOF_FAILURE = "Pi saved a compaction without valid pi-continue/v4 handoff details.";
export const STALE_COMPACTION_PROOF_FAILURE = "Pi saved a continuation handoff for a different run; resume was stopped.";

export interface PendingResumeDispatch {
	eventId: string;
	label: string;
	sendContinuation: (prompt: string) => void;
	onContinuationFailed: ((eventId: string) => void) | undefined;
	resumeStartTimeoutMs: number;
	compactionProofTimeoutMs: number;
	failureGuardKey: string | undefined;
	compactionCompleted: boolean;
	proofVerified: boolean;
}

export interface AwaitingResumeStart {
	eventId: string;
	label: string;
	onContinuationFailed: ((eventId: string) => void) | undefined;
	resumeStartTimeoutMs: number;
}

export interface ResumeProofRuntimeState extends ContinuationEventStore {
	compactionRunning: boolean;
	guardFailureKey: string | undefined;
	awaitingResumeEventId: string | undefined;
	awaitingResumeStart: AwaitingResumeStart | undefined;
	resumeStartTimeout: ReturnType<typeof setTimeout> | undefined;
	compactionProofTimeout: ReturnType<typeof setTimeout> | undefined;
	pendingResumeDispatch: PendingResumeDispatch | undefined;
}

export interface PendingResumeDispatchOptions {
	eventId: string;
	label: string;
	sendContinuation: (prompt: string) => void;
	onContinuationFailed: ((eventId: string) => void) | undefined;
	resumeStartTimeoutMs: number;
	compactionProofTimeoutMs: number;
	failureGuardKey: string | undefined;
}

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, type);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (typeof timer === "object" && timer !== null) timer.unref?.();
}

function clearResumeStartTimer(runtime: ResumeProofRuntimeState): void {
	if (!runtime.resumeStartTimeout) return;
	clearTimeout(runtime.resumeStartTimeout);
	runtime.resumeStartTimeout = undefined;
}

export function clearResumeStartTimeout(runtime: ResumeProofRuntimeState): void {
	clearResumeStartTimer(runtime);
	runtime.awaitingResumeStart = undefined;
}

export function clearCompactionProofTimeout(runtime: ResumeProofRuntimeState): void {
	if (!runtime.compactionProofTimeout) return;
	clearTimeout(runtime.compactionProofTimeout);
	runtime.compactionProofTimeout = undefined;
}

export function clearPendingResumeDispatch(runtime: ResumeProofRuntimeState): void {
	runtime.pendingResumeDispatch = undefined;
	clearCompactionProofTimeout(runtime);
}

export function preparePendingResumeDispatch(runtime: ResumeProofRuntimeState, options: PendingResumeDispatchOptions): void {
	runtime.pendingResumeDispatch = {
		eventId: options.eventId,
		label: options.label,
		sendContinuation: options.sendContinuation,
		onContinuationFailed: options.onContinuationFailed,
		resumeStartTimeoutMs: options.resumeStartTimeoutMs,
		compactionProofTimeoutMs: options.compactionProofTimeoutMs,
		failureGuardKey: options.failureGuardKey,
		compactionCompleted: false,
		proofVerified: false,
	};
}

function scheduleResumeStartTimeout(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, resumeStart: AwaitingResumeStart): void {
	clearResumeStartTimer(runtime);
	runtime.awaitingResumeStart = resumeStart;
	const timeout = setTimeout(() => {
		if (runtime.awaitingResumeEventId !== resumeStart.eventId) return;
		const failed = failContinuationResumeStart(runtime, resumeStart.eventId, RESUME_START_TIMEOUT_FAILURE);
		if (!failed) return;
		resumeStart.onContinuationFailed?.(resumeStart.eventId);
		settleWorkingVisuals(ctx, runtime, resumeStart.eventId);
		notify(ctx, `${resumeStart.label}: resume request failed.`, "error");
	}, Math.max(0, resumeStart.resumeStartTimeoutMs));
	runtime.resumeStartTimeout = timeout;
	unrefTimer(timeout);
}

function scheduleCompactionProofTimeout(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, pending: PendingResumeDispatch): void {
	clearCompactionProofTimeout(runtime);
	const timeout = setTimeout(() => {
		if (runtime.pendingResumeDispatch?.eventId !== pending.eventId || runtime.pendingResumeDispatch.proofVerified) return;
		failContinuationCompactionProof(ctx, runtime, pending.eventId, COMPACTION_PROOF_TIMEOUT_FAILURE);
	}, Math.max(0, pending.compactionProofTimeoutMs));
	runtime.compactionProofTimeout = timeout;
	unrefTimer(timeout);
}

function failContinuationResumeStart(runtime: ResumeProofRuntimeState, eventId: string, reason: string): boolean {
	if (!finishContinuationEvent(runtime, eventId, "failed", reason)) return false;
	clearResumeStartTimeout(runtime);
	runtime.awaitingResumeEventId = undefined;
	return true;
}

function isAwaitingResumeStartPending(runtime: ResumeProofRuntimeState, eventId: string): boolean {
	return runtime.awaitingResumeEventId === eventId
		&& runtime.latestEvent?.id === eventId
		&& runtime.latestEvent.resume.status === "pending";
}

/** Arm the resume-start timeout after an active parent turn had a chance to deliver queued follow-up. */
export function armDeferredResumeStartTimeout(ctx: ExtensionContext, runtime: ResumeProofRuntimeState): boolean {
	const resumeStart = runtime.awaitingResumeStart;
	if (!resumeStart || runtime.resumeStartTimeout) return false;
	if (!isAwaitingResumeStartPending(runtime, resumeStart.eventId)) return false;
	scheduleResumeStartTimeout(ctx, runtime, resumeStart);
	return true;
}

function dispatchIfReady(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId || !pending.compactionCompleted || !pending.proofVerified) return false;
	if (!isActiveRunningContinuationEvent(runtime, eventId)) return false;
	clearCompactionProofTimeout(runtime);
	runtime.pendingResumeDispatch = undefined;
	updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resuming this session");
	markContinuationResumePending(runtime, eventId);
	runtime.awaitingResumeEventId = eventId;
	const resumeStart: AwaitingResumeStart = {
		eventId: pending.eventId,
		label: pending.label,
		onContinuationFailed: pending.onContinuationFailed,
		resumeStartTimeoutMs: pending.resumeStartTimeoutMs,
	};
	runtime.awaitingResumeStart = resumeStart;
	try {
		// 摇树 handoff 没有 LLM brief，使用简短版恢复引导，避免模型去找不存在的 brief 结构。
		const prompt = runtime.latestEvent?.id === eventId && runtime.latestEvent.shaken
			? SHAKE_CONTINUATION_PROMPT
			: CONTINUATION_PROMPT;
		pending.sendContinuation(prompt);
		markContinuationPromptSent(runtime, eventId);
		if (ctx.isIdle() && isAwaitingResumeStartPending(runtime, eventId)) {
			scheduleResumeStartTimeout(ctx, runtime, resumeStart);
		}
		notify(ctx, `${pending.label}: resume request sent.`, "info");
	} catch {
		pending.onContinuationFailed?.(eventId);
		finishContinuationEvent(runtime, eventId, "failed", PROMPT_DISPATCH_FAILURE);
		clearResumeStartTimeout(runtime);
		runtime.awaitingResumeEventId = undefined;
		settleWorkingVisuals(ctx, runtime, eventId);
		notify(ctx, `${pending.label}: resume request failed: ${PROMPT_DISPATCH_FAILURE}`, "error");
		return false;
	}
	return true;
}

export function markContinuationCompactionComplete(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId) return false;
	pending.compactionCompleted = true;
	if (pending.proofVerified) return dispatchIfReady(ctx, runtime, eventId);
	updateWorkingVisuals(ctx, runtime, eventId, "pi-continue verifying saved handoff");
	scheduleCompactionProofTimeout(ctx, runtime, pending);
	return true;
}

export function verifyContinuationCompactionProof(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string, compactionEntryId: string): boolean {
	if (!markContinuationCompactionProofVerified(runtime, eventId, compactionEntryId)) return false;
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId) {
		clearCompactionProofTimeout(runtime);
		return true;
	}
	pending.proofVerified = true;
	clearCompactionProofTimeout(runtime);
	return true;
}

export function dispatchVerifiedContinuationResume(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string): boolean {
	return dispatchIfReady(ctx, runtime, eventId);
}

export function acceptContinuationCompactionProof(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string, compactionEntryId: string): boolean {
	if (!verifyContinuationCompactionProof(ctx, runtime, eventId, compactionEntryId)) return false;
	dispatchVerifiedContinuationResume(ctx, runtime, eventId);
	return true;
}

export function failContinuationCompactionProof(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string, reason: string): boolean {
	markContinuationCompactionProofFailed(runtime, eventId, reason);
	const pending = runtime.pendingResumeDispatch;
	if (pending?.eventId === eventId) {
		pending.onContinuationFailed?.(eventId);
		if (pending.failureGuardKey) runtime.guardFailureKey = pending.failureGuardKey;
	}
	clearPendingResumeDispatch(runtime);
	clearResumeStartTimeout(runtime);
	runtime.awaitingResumeEventId = undefined;
	runtime.compactionRunning = false;
	if (!finishContinuationEvent(runtime, eventId, "failed", reason)) return false;
	settleWorkingVisuals(ctx, runtime, eventId);
	notify(ctx, `pi-continue: handoff failed: ${reason}`, "error");
	return true;
}
