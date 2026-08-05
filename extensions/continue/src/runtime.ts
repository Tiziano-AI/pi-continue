import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_PROMPT } from "./continuation-prompt.ts";
import {
	beginContinuationEvent,
	finishContinuationEvent,
	isActiveRunningContinuationEvent,
	markContinuationResumeStarted,
	recordBlockedContinuationEvent,
	settleContinuationResume,
} from "./continuation-event.ts";
import type {
	ContinuationEventSource,
	ContinuationLatestEvent,
	ContinuationAdoptionCheckpoint,
	ContinuationLedgerSnapshot,
	ContinuationResumeStatus,
	ContinuationTurnProvenance,
	MidRunGuardTrigger,
} from "./types.ts";
import {
	clearPendingResumeDispatch,
	clearResumeStartTimeout,
	markContinuationCompactionComplete,
	notify,
	preparePendingResumeDispatch,
	type ResumeProofRuntimeState,
} from "./resume-proof.ts";
import {
	beginWorkingVisuals,
	settleWorkingVisuals,
} from "./working-ui.ts";

export { CONTINUATION_PROMPT } from "./continuation-prompt.ts";
export { acceptContinuationCompactionProof, armDeferredResumeStartTimeout, clearResumeStartTimeout, dispatchVerifiedContinuationResume, failContinuationCompactionProof, markContinuationCompactionComplete, verifyContinuationCompactionProof } from "./resume-proof.ts";

export type ContinuationRequestMode = "steer" | "queue";
export type ContinuationRequestSource = ContinuationEventSource;

export interface ContinuationRuntimeState extends ResumeProofRuntimeState, ContinuationTurnProvenance {
	latestLedger: ContinuationLedgerSnapshot | undefined;
	lastNoCompactableGuardKey: string | undefined;
}

export interface ContinuationRequest {
	mode: ContinuationRequestMode;
	instructions: string | undefined;
}

export interface StartContinuationCompactionOptions {
	source: ContinuationRequestSource;
	instructions: string | undefined;
	trigger: MidRunGuardTrigger | undefined;
	abortActiveRun: boolean;
	continueAfterComplete: boolean;
	sendContinuation: (prompt: string) => void;
	onContinuationFailed?: (eventId: string) => void;
	resumeStartTimeoutMs?: number;
	compactionProofTimeoutMs?: number;
}

export interface ContinuationResumeSettlement {
	eventId: string;
	status: Exclude<ContinuationResumeStatus, "not-requested" | "pending" | "running">;
}

const MODE_TOKENS = new Set<string>(["steer", "queue"]);
const RESUME_START_TIMEOUT_MS = 30_000;
const BLOCKED_RETRY_FAILURE = "Repeated over-limit retry was blocked after a failed continuation.";
const COMPACTION_FAILURE = "Continuation handoff failed.";
const RESUME_ABORTED_FAILURE = "Continuation resume was aborted.";
const RESUME_LIMIT_FAILURE = "Continuation resume stopped before completing because a model limit was reached.";
const RESUME_NO_ASSISTANT_FAILURE = "Continuation resume did not produce an assistant response.";
const CHAINED_CONTINUATION_STOP_REASON = "chained-continuation";

function isContinuationRequestMode(value: string): value is ContinuationRequestMode {
	return MODE_TOKENS.has(value);
}

function mergeInstructions(parts: (string | undefined)[]): string | undefined {
	const merged = parts
		.map((part) => part?.trim())
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join("\n\n");
	return merged.length > 0 ? merged : undefined;
}

/** Parse the canonical /continue command contract. */
export function parseContinuationRequest(args: string | undefined): ContinuationRequest {
	const trimmed = args?.trim() ?? "";
	if (!trimmed) return { mode: "steer", instructions: undefined };
	const spaceIndex = trimmed.search(/\s/);
	const first = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const normalizedFirst = first.toLowerCase();
	if (!isContinuationRequestMode(normalizedFirst)) return { mode: "steer", instructions: trimmed };
	const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	return {
		mode: normalizedFirst,
		instructions: rest.length > 0 ? rest : undefined,
	};
}

export function createContinuationRuntimeState(): ContinuationRuntimeState {
	return {
		compactionRunning: false,
		guardFailureKey: undefined,
		awaitingResumeEventId: undefined,
		awaitingResumeStart: undefined,
		resumeStartTimeout: undefined,
		compactionProofTimeout: undefined,
		pendingResumeDispatch: undefined,
		latestLedger: undefined,
		lastNoCompactableGuardKey: undefined,
		adoptionCheckpoint: undefined,
		lastAssistantStopReason: undefined,
		latestEvent: undefined,
		activeEventId: undefined,
		nextEventSequence: 0,
	};
}

/** Return the runtime-local latest event rendered by /continue status. */
export function getLatestContinuationEvent(runtime: ContinuationRuntimeState): ContinuationLatestEvent | undefined {
	return runtime.latestEvent;
}

export function getLatestContinuationLedger(runtime: ContinuationRuntimeState): ContinuationLedgerSnapshot | undefined {
	return runtime.latestLedger;
}

export function describeGuardTrigger(trigger: MidRunGuardTrigger): string {
	return `${trigger.estimatedTokens.toLocaleString()}/${trigger.contextWindow.toLocaleString()} tokens, threshold ${trigger.thresholdTokens.toLocaleString()}`;
}

export function buildGuardFailureKey(trigger: MidRunGuardTrigger): string {
	return [
		trigger.contextWindow,
		trigger.reserveTokens,
		trigger.thresholdTokens,
		trigger.estimatedTokens,
		trigger.usageTokens,
		trigger.trailingTokens,
		trigger.lastUsageIndex ?? "none",
	].join(":");
}

export function buildGuardInstructions(trigger: MidRunGuardTrigger): string {
	return [
		"Automatic mid-run continuation triggered after a completed assistant/tool-result batch, before Pi sent another model request.",
		`Estimated context: ${trigger.estimatedTokens} tokens.`,
		`Compaction threshold: ${trigger.thresholdTokens} tokens (${trigger.contextWindow} context window - ${trigger.reserveTokens} reserve).`,
		"Prioritize current state, latest tool results, remaining task intent, file changes, blockers, and exact next steps.",
	].join("\n");
}

function sourceLabel(source: ContinuationEventSource): string {
	if (source === "command-queue") return "queued /continue";
	if (source === "command-steer") return "/continue steer";
	if (source === "adopted-compaction") return "adopted automatic compaction";
	return "automatic continuation";
}

function isAwaitingResumeEventCurrent(runtime: ContinuationRuntimeState): boolean {
	const eventId = runtime.awaitingResumeEventId;
	return eventId !== undefined
		&& runtime.activeEventId === eventId
		&& runtime.latestEvent?.id === eventId
		&& runtime.latestEvent.status === "running";
}

export function clearStaleAwaitingContinuationResume(runtime: ContinuationRuntimeState): void {
	if (runtime.awaitingResumeEventId && !isAwaitingResumeEventCurrent(runtime)) {
		runtime.awaitingResumeEventId = undefined;
		clearResumeStartTimeout(runtime);
	}
	if (runtime.pendingResumeDispatch && runtime.pendingResumeDispatch.eventId !== runtime.activeEventId) {
		clearPendingResumeDispatch(runtime);
	}
}

function hasActiveContinuationSettlement(runtime: ContinuationRuntimeState): boolean {
	clearStaleAwaitingContinuationResume(runtime);
	return runtime.activeEventId !== undefined || runtime.awaitingResumeEventId !== undefined;
}

function finishRunningResumeForChainedContinuation(runtime: ContinuationRuntimeState): boolean {
	clearStaleAwaitingContinuationResume(runtime);
	const eventId = runtime.awaitingResumeEventId;
	if (!eventId || runtime.activeEventId !== eventId || runtime.latestEvent?.id !== eventId) return false;
	if (runtime.latestEvent.resume.status !== "running") return false;
	if (!settleContinuationResume(runtime, eventId, "completed", { stopReason: CHAINED_CONTINUATION_STOP_REASON })) return false;
	clearResumeStartTimeout(runtime);
	runtime.awaitingResumeEventId = undefined;
	return true;
}

function compactionFailureReason(runtime: ContinuationRuntimeState, eventId: string): string {
	const event = runtime.latestEvent;
	if (event?.id === eventId && event.artifactStatus === "aborted" && event.failureReason) return event.failureReason;
	return COMPACTION_FAILURE;
}

/** Whether Pi already saved and reported this event's package-owned handoff entry. */
function hasVerifiedCompactionProof(runtime: ContinuationRuntimeState, eventId: string): boolean {
	const event = runtime.latestEvent;
	return event?.id === eventId && event.compactionProof.status === "verified";
}

/** Start the package-owned compaction pipeline once, with visible lifecycle settlement. */
export function startContinuationCompaction(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	options: StartContinuationCompactionOptions,
): boolean {
	clearStaleAwaitingContinuationResume(runtime);
	if (runtime.compactionRunning) {
		if (options.abortActiveRun && options.source === "mid-run-guard") ctx.abort();
		notify(ctx, "A continuation handoff is already being saved.", "warning");
		return false;
	}
	if (options.source === "mid-run-guard") {
		finishRunningResumeForChainedContinuation(runtime);
	}
	if (hasActiveContinuationSettlement(runtime)) {
		if (options.source === "mid-run-guard" && options.abortActiveRun) ctx.abort();
		notify(ctx, "The previous continuation is still resuming; no new handoff was started.", "warning");
		return false;
	}
	const guardKey = options.trigger ? buildGuardFailureKey(options.trigger) : undefined;
	if (options.source === "mid-run-guard" && guardKey && runtime.guardFailureKey === guardKey) {
		ctx.abort();
		recordBlockedContinuationEvent(
			runtime,
			options.source,
			options.trigger,
			BLOCKED_RETRY_FAILURE,
		);
		notify(ctx, "pi-continue paused before another over-limit model request. Review /continue status before retrying.", "error");
		return false;
	}
	runtime.compactionRunning = true;
	const event = beginContinuationEvent(
		runtime,
		options.source,
		options.trigger,
		options.continueAfterComplete ? "pending" : "not-requested",
	);
	beginWorkingVisuals(ctx, runtime, event.id, "pi-continue saving handoff");
	// Pi's ctx.compact() aborts the active operation before it prepares the compaction.
	// Calling ctx.abort() first lets Pi's automatic compaction race the package-owned
	// request and can leave the latter with an "Already compacted" error, so this pipeline
	// has one abort owner: ctx.compact(). The compaction Pi may still start from that
	// aborted turn is cancelled in the session_before_compact handler.
	const label = sourceLabel(options.source);
	const triggerText = options.trigger ? ` (${describeGuardTrigger(options.trigger)})` : "";
	notify(ctx, `${label}: saving handoff${triggerText}.`, "info");
	const customInstructions = mergeInstructions([
		options.instructions,
		options.trigger ? buildGuardInstructions(options.trigger) : undefined,
	]);
	let compactionCallbackSettled = false;
	function claimCompactionCallback(): boolean {
		if (compactionCallbackSettled) return false;
		compactionCallbackSettled = true;
		return isActiveRunningContinuationEvent(runtime, event.id);
	}
	if (options.continueAfterComplete) {
		preparePendingResumeDispatch(runtime, {
			eventId: event.id,
			label,
			sendContinuation: options.sendContinuation,
			onContinuationFailed: options.onContinuationFailed,
			resumeStartTimeoutMs: options.resumeStartTimeoutMs ?? RESUME_START_TIMEOUT_MS,
			compactionProofTimeoutMs: options.compactionProofTimeoutMs ?? RESUME_START_TIMEOUT_MS,
			failureGuardKey: guardKey,
		});
	}
	function failCompaction(reason: string): void {
		runtime.compactionRunning = false;
		if (guardKey) runtime.guardFailureKey = guardKey;
		options.onContinuationFailed?.(event.id);
		finishContinuationEvent(runtime, event.id, "failed", reason);
		clearPendingResumeDispatch(runtime);
		clearResumeStartTimeout(runtime);
		runtime.awaitingResumeEventId = undefined;
		settleWorkingVisuals(ctx, runtime, event.id);
		notify(ctx, `${label}: handoff failed: ${reason}`, "error");
	}
	function completeCompaction(): void {
		runtime.compactionRunning = false;
		runtime.guardFailureKey = undefined;
		if (options.continueAfterComplete) {
			markContinuationCompactionComplete(ctx, runtime, event.id);
			return;
		}
		finishContinuationEvent(runtime, event.id, "completed", undefined);
		settleWorkingVisuals(ctx, runtime, event.id);
		notify(ctx, `${label}: handoff saved.`, "info");
	}
	try {
		ctx.compact({
			customInstructions,
			onComplete: () => {
				if (!claimCompactionCallback()) return;
				completeCompaction();
			},
			onError: () => {
				if (!claimCompactionCallback()) return;
				// A concurrent compaction can save this event's package-owned handoff before Pi
				// runs the package's own request, which then fails with "Already compacted".
				// Pi's saved and reported entry is the handoff, so the resume follows that proof
				// instead of failing a handoff Pi already stored.
				if (hasVerifiedCompactionProof(runtime, event.id)) {
					notify(ctx, `${label}: another compaction already saved this handoff.`, "warning");
					completeCompaction();
					return;
				}
				failCompaction(compactionFailureReason(runtime, event.id));
			},
		});
	} catch {
		failCompaction(compactionFailureReason(runtime, event.id));
		return false;
	}
	return true;
}

/** Record the stop reason of the assistant response that just finished. */
export function recordAssistantStopReason(runtime: ContinuationRuntimeState, stopReason: string | undefined): void {
	runtime.lastAssistantStopReason = stopReason;
}

/** Open the single adoptable checkpoint for the assistant turn that just ended. */
export function openContinuationAdoptionCheckpoint(runtime: ContinuationRuntimeState): void {
	runtime.adoptionCheckpoint = { stopReason: runtime.lastAssistantStopReason, openedAt: Date.now() };
}

/** Close the checkpoint because new user input or a new turn owns what happens next. */
export function clearContinuationAdoptionCheckpoint(runtime: ContinuationRuntimeState): void {
	runtime.adoptionCheckpoint = undefined;
}

/** Claim the checkpoint for at most one compaction, so a later compaction cannot reuse it. */
export function consumeContinuationAdoptionCheckpoint(runtime: ContinuationRuntimeState): ContinuationAdoptionCheckpoint | undefined {
	const checkpoint = runtime.adoptionCheckpoint;
	runtime.adoptionCheckpoint = undefined;
	return checkpoint;
}

export interface AdoptedContinuationCompactionOptions {
	trigger: MidRunGuardTrigger;
	continueAfterComplete: boolean;
	sendContinuation: (prompt: string) => void;
	onContinuationFailed?: (eventId: string) => void;
	resumeStartTimeoutMs?: number;
	compactionProofTimeoutMs?: number;
}

/**
 * Take ownership of an over-threshold compaction Pi started on its own.
 *
 * Pi runs its automatic compaction at the end of a turn, where the package's
 * mid-run guard never sees the context. Without adoption those checkpoints fall
 * back to Pi's own summarizer and the session continues without a ledger or a
 * same-session resume.
 */
export function startAdoptedContinuationCompaction(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	options: AdoptedContinuationCompactionOptions,
): string | undefined {
	clearStaleAwaitingContinuationResume(runtime);
	if (runtime.compactionRunning || hasActiveContinuationSettlement(runtime)) return undefined;
	const event = beginContinuationEvent(
		runtime,
		"adopted-compaction",
		options.trigger,
		options.continueAfterComplete ? "pending" : "not-requested",
	);
	beginWorkingVisuals(ctx, runtime, event.id, "pi-continue saving handoff");
	const label = sourceLabel("adopted-compaction");
	notify(ctx, `${label}: saving handoff (${describeGuardTrigger(options.trigger)}).`, "info");
	if (options.continueAfterComplete) {
		preparePendingResumeDispatch(runtime, {
			eventId: event.id,
			label,
			sendContinuation: options.sendContinuation,
			onContinuationFailed: options.onContinuationFailed,
			resumeStartTimeoutMs: options.resumeStartTimeoutMs ?? RESUME_START_TIMEOUT_MS,
			compactionProofTimeoutMs: options.compactionProofTimeoutMs ?? RESUME_START_TIMEOUT_MS,
			failureGuardKey: undefined,
		});
	}
	return event.id;
}

/**
 * Hand an adopted compaction back to Pi when the package could not build a usable handoff.
 *
 * Only state that still belongs to this event is cleared: a stale caller whose owner was
 * already settled must not disturb a newer continuation.
 */
export function releaseAdoptedContinuationCompaction(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	eventId: string,
	onContinuationFailed?: (eventId: string) => void,
): void {
	if (!isActiveRunningContinuationEvent(runtime, eventId)) return;
	const reason = compactionFailureReason(runtime, eventId);
	onContinuationFailed?.(eventId);
	if (runtime.pendingResumeDispatch?.eventId === eventId) clearPendingResumeDispatch(runtime);
	if (runtime.awaitingResumeStart?.eventId === eventId) clearResumeStartTimeout(runtime);
	if (runtime.awaitingResumeEventId === eventId) runtime.awaitingResumeEventId = undefined;
	if (!finishContinuationEvent(runtime, eventId, "failed", reason)) return;
	settleWorkingVisuals(ctx, runtime, eventId);
	notify(ctx, `${sourceLabel("adopted-compaction")}: handoff failed: ${reason} Pi kept its own compaction.`, "warning");
}

export function markAwaitingContinuationResumeStarted(runtime: ContinuationRuntimeState): string | undefined {
	clearStaleAwaitingContinuationResume(runtime);
	const eventId = runtime.awaitingResumeEventId;
	if (!eventId) return undefined;
	if (!markContinuationResumeStarted(runtime, eventId)) return undefined;
	clearResumeStartTimeout(runtime);
	return eventId;
}

function requestedAssistantModel(message: AssistantMessage): string {
	return `${message.provider}/${message.model}`;
}

export function settleAwaitingContinuationResumeFromAssistant(
	runtime: ContinuationRuntimeState,
	message: AssistantMessage,
): ContinuationResumeSettlement | undefined {
	clearStaleAwaitingContinuationResume(runtime);
	const eventId = runtime.awaitingResumeEventId;
	if (!eventId || runtime.latestEvent?.id !== eventId || runtime.latestEvent.resume.status !== "running") return undefined;
	if (message.stopReason === "toolUse") return undefined;
	if (message.stopReason === "stop") {
		if (settleContinuationResume(runtime, eventId, "completed", {
			stopReason: message.stopReason,
			requestedModel: requestedAssistantModel(message),
			responseModel: message.responseModel,
		})) {
			clearResumeStartTimeout(runtime);
			runtime.awaitingResumeEventId = undefined;
			return { eventId, status: "completed" };
		}
		return undefined;
	}
	if (message.stopReason === "aborted") {
		if (settleContinuationResume(runtime, eventId, "aborted", {
			stopReason: message.stopReason,
			requestedModel: requestedAssistantModel(message),
			responseModel: message.responseModel,
			failureReason: RESUME_ABORTED_FAILURE,
		})) {
			clearResumeStartTimeout(runtime);
			runtime.awaitingResumeEventId = undefined;
			return { eventId, status: "aborted" };
		}
		return undefined;
	}
	const reason = message.stopReason === "length"
		? RESUME_LIMIT_FAILURE
		: RESUME_NO_ASSISTANT_FAILURE;
	if (settleContinuationResume(runtime, eventId, "failed", {
		stopReason: message.stopReason,
		requestedModel: requestedAssistantModel(message),
		responseModel: message.responseModel,
		failureReason: reason,
	})) {
		clearResumeStartTimeout(runtime);
		runtime.awaitingResumeEventId = undefined;
		return { eventId, status: "failed" };
	}
	return undefined;
}

export function failAwaitingContinuationResume(runtime: ContinuationRuntimeState, reason: string): string | undefined {
	clearStaleAwaitingContinuationResume(runtime);
	const eventId = runtime.awaitingResumeEventId;
	if (!eventId) return undefined;
	if (!settleContinuationResume(runtime, eventId, "failed", { failureReason: reason })) return undefined;
	clearResumeStartTimeout(runtime);
	runtime.awaitingResumeEventId = undefined;
	return eventId;
}

export function failRunningAwaitingContinuationResume(
	runtime: ContinuationRuntimeState,
	reason: string,
): ContinuationResumeSettlement | undefined {
	clearStaleAwaitingContinuationResume(runtime);
	const eventId = runtime.awaitingResumeEventId;
	if (!eventId || runtime.latestEvent?.id !== eventId || runtime.latestEvent.resume.status !== "running") return undefined;
	if (!settleContinuationResume(runtime, eventId, "failed", { failureReason: reason })) return undefined;
	clearResumeStartTimeout(runtime);
	runtime.awaitingResumeEventId = undefined;
	return { eventId, status: "failed" };
}

/** Execute /continue in immediate steer mode or wait-until-idle queue mode. */
export async function runContinuationCommand(
	ctx: ExtensionCommandContext,
	runtime: ContinuationRuntimeState,
	args: string | undefined,
	sendContinuation: (prompt: string) => void,
	onContinuationFailed?: (eventId: string) => void,
): Promise<void> {
	const request = parseContinuationRequest(args);
	if (request.mode === "queue") {
		notify(ctx, "Queued continuation for the next idle point.", "info");
		await ctx.waitForIdle();
		startContinuationCompaction(ctx, runtime, {
			source: "command-queue",
			instructions: request.instructions,
			trigger: undefined,
			abortActiveRun: false,
			continueAfterComplete: true,
			sendContinuation,
			onContinuationFailed,
		});
		return;
	}
	startContinuationCompaction(ctx, runtime, {
		source: "command-steer",
		instructions: request.instructions,
		trigger: undefined,
		abortActiveRun: !ctx.isIdle(),
		continueAfterComplete: true,
		sendContinuation,
		onContinuationFailed,
	});
}
