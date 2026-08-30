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
import { describeCompactionThreshold } from "./threshold.ts";
import type {
	ContinuationEventSource,
	ContinuationLatestEvent,
	ContinuationLedgerSnapshot,
	ContinuationResumeStatus,
	ContinuationSynthesisFailure,
	MidRunGuardTrigger,
	NativeCompactionAdoptionCheckpoint,
	ContinuationResumeOwner,
} from "./types.ts";
import {
	clearPendingResumeDispatch,
	clearResumeStartTimeout,
	markContinuationCompactionComplete,
	markContinuationCompactionCompleteFromHost,
	notify,
	preparePendingResumeDispatch,
	type ResumeProofRuntimeState,
} from "./resume-proof.ts";
import {
	beginWorkingVisuals,
	settleWorkingVisuals,
} from "./working-ui.ts";

export { CONTINUATION_PROMPT } from "./continuation-prompt.ts";
export { acceptContinuationCompactionProof, armContinuationCompactionProofTimeout, armDeferredResumeStartTimeout, clearResumeStartTimeout, dispatchVerifiedContinuationResume, failContinuationCompactionProof, markContinuationCompactionRunMode, markContinuationCompactionComplete, observeCooperativeContinuationPrompt, observeCooperativeContinuationTurn, verifyContinuationCompactionProof } from "./resume-proof.ts";

export type ContinuationRequestMode = "steer" | "queue";
export type ContinuationRequestSource = Exclude<ContinuationEventSource, "adopted-compaction">;

export interface ContinuationRuntimeState extends ResumeProofRuntimeState {
	latestLedger: ContinuationLedgerSnapshot | undefined;
	controlledMidRunAbortRequested: boolean;
	lastNoCompactableGuardKey: string | undefined;
	nativeCompactionAdoptionCheckpoint: NativeCompactionAdoptionCheckpoint | undefined;
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
	deferToNativeCompaction?: boolean;
	sendContinuation: (prompt: string) => void;
	onContinuationFailed?: (eventId: string) => void;
	resumeStartTimeoutMs?: number;
	compactionProofTimeoutMs?: number;
	resumeOwner?: ContinuationResumeOwner;
	sameRunCompaction?: boolean;
}

export interface StartAdoptedNativeCompactionOptions {
	sendContinuation: (prompt: string) => void;
	onContinuationFailed?: (eventId: string) => void;
	resumeStartTimeoutMs?: number;
	compactionProofTimeoutMs?: number;
	resumeOwner?: ContinuationResumeOwner;
	sameRunCompaction?: boolean;
}

export interface ContinuationResumeSettlement {
	eventId: string;
	status: Exclude<ContinuationResumeStatus, "not-requested" | "pending" | "running">;
}

const MODE_TOKENS = new Set<string>(["steer", "queue"]);
const RESUME_START_TIMEOUT_MS = 30_000;
const BLOCKED_RETRY_FAILURE = "Repeated over-limit retry was blocked after a failed continuation.";
const COMPACTION_FAILURE = "Continuation handoff failed.";
const NON_CONTINUATION_RUN_FAILURE = "A newer non-continuation run superseded the pending continuation resume.";
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
		controlledMidRunAbortRequested: false,
		awaitingResumeEventId: undefined,
		awaitingResumeStart: undefined,
		resumeStartTimeout: undefined,
		externalResumeTimeout: undefined,
		resumeDispatchTimer: undefined,
		compactionProofTimeout: undefined,
		pendingResumeDispatch: undefined,
		latestLedger: undefined,
		lastNoCompactableGuardKey: undefined,
		nativeCompactionAdoptionCheckpoint: undefined,
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

export function normalizeMidRunGuardAbortMessage(
	runtime: ContinuationRuntimeState,
	message: AssistantMessage,
): AssistantMessage {
	const activeEvent = runtime.latestEvent;
	if (
		!runtime.compactionRunning
		|| !runtime.controlledMidRunAbortRequested
		|| activeEvent?.source !== "mid-run-guard"
		|| !isActiveRunningContinuationEvent(runtime, activeEvent.id)
		|| (message.stopReason !== "error" && message.stopReason !== "aborted")
		|| (message.stopReason === "error"
			&& (typeof message.errorMessage !== "string" || !message.errorMessage.toLowerCase().includes("abort")))
	) {
		return message;
	}
	// 当前运行已由自动 handoff 接管；先中性收束旧 turn，避免 Pi 将内部控制流渲染成用户可见失败。
	runtime.controlledMidRunAbortRequested = false;
	return {
		...message,
		content: [],
		stopReason: "stop",
		errorMessage: undefined,
	};
}

/** 只在助手正常结束后开放一次紧邻的阈值压缩资格。 */
export function recordNativeCompactionAdoptionCheckpoint(
	runtime: ContinuationRuntimeState,
	stopReason: string,
): void {
	runtime.nativeCompactionAdoptionCheckpoint = stopReason === "stop"
		? { stopReason, openedAt: Date.now() }
		: undefined;
}

export function clearNativeCompactionAdoptionCheckpoint(runtime: ContinuationRuntimeState): void {
	runtime.nativeCompactionAdoptionCheckpoint = undefined;
}

/** 将宿主已保存的、带有匹配 proof 的压缩交给单一 resume 闭环。 */
export function completeContinuationCompactionFromHost(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	eventId: string,
): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (
		!pending
		|| pending.eventId !== eventId
		|| runtime.latestEvent?.compactionProof.status !== "verified"
		|| !isActiveRunningContinuationEvent(runtime, eventId)
	) {
		return false;
	}
	runtime.compactionRunning = false;
	runtime.controlledMidRunAbortRequested = false;
	runtime.guardFailureKey = undefined;
	return pending.hostCompaction
		? markContinuationCompactionCompleteFromHost(ctx, runtime, eventId)
		: markContinuationCompactionComplete(ctx, runtime, eventId);
}

export function consumeNativeCompactionAdoptionCheckpoint(
	runtime: ContinuationRuntimeState,
): NativeCompactionAdoptionCheckpoint | undefined {
	const checkpoint = runtime.nativeCompactionAdoptionCheckpoint;
	runtime.nativeCompactionAdoptionCheckpoint = undefined;
	return checkpoint;
}

export function describeGuardTrigger(trigger: MidRunGuardTrigger): string {
	return `${trigger.estimatedTokens.toLocaleString()}/${trigger.contextWindow.toLocaleString()} tokens, threshold ${trigger.thresholdTokens.toLocaleString()}`;
}

export function buildGuardFailureKey(trigger: MidRunGuardTrigger): string {
	return [
		trigger.mode,
		trigger.contextWindow,
		trigger.mode === "reserve-tokens" ? trigger.reserveTokens : trigger.percentage,
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
		`Compaction threshold: ${describeCompactionThreshold(trigger)}.`,
		"Prioritize current state, latest tool results, remaining task intent, file changes, blockers, and exact next steps.",
	].join("\n");
}

function sourceLabel(source: ContinuationRequestSource): string {
	if (source === "command-queue") return "queued /continue";
	if (source === "command-steer") return "/continue steer";
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

/** 把已记录的分类器转成可读诊断，让用户当场区分限流、超时、认证等失败。 */
function describeSynthesisFailure(failure: ContinuationSynthesisFailure): string {
	const requested = failure.requestedModel ? `; requested ${failure.requestedModel}` : "";
	const http = failure.httpStatus !== undefined ? `; HTTP ${failure.httpStatus}` : "";
	switch (failure.code) {
		case "model-unresolved":
			return `handoff model could not be resolved${requested}`;
		case "auth-unavailable":
			return `handoff model auth is unavailable${requested}`;
		case "provider-error":
			return `handoff model provider error${http}${requested}`;
		case "provider-aborted":
			return `handoff synthesis was aborted${requested}`;
		case "provider-timeout":
			return `handoff synthesis timed out${requested}`;
		case "artifact-empty":
			return "handoff artifact was empty";
		case "artifact-invalid-json":
			return "handoff artifact was not valid JSON";
		case "artifact-invalid-shape":
			return "handoff artifact did not match the current v4 JSON contract";
		default:
			return "internal synthesis failure";
	}
}

function compactionFailureReason(runtime: ContinuationRuntimeState, eventId: string): string {
	const event = runtime.latestEvent;
	if (event?.id === eventId && event.artifactStatus === "aborted") {
		// 固定文案只作兜底；已记录的分类器能提供可操作的失败方向。
		if (event.synthesisFailure) return `synthesis failed: ${describeSynthesisFailure(event.synthesisFailure)}`;
		if (event.failureReason) return event.failureReason;
	}
	return COMPACTION_FAILURE;
}

/** 接管 Pi 已发起的阈值压缩，不再调用压缩或中止当前运行。 */
export function startAdoptedNativeCompaction(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	options: StartAdoptedNativeCompactionOptions,
): string | undefined {
	clearStaleAwaitingContinuationResume(runtime);
	if (runtime.compactionRunning || hasActiveContinuationSettlement(runtime)) return undefined;
	const event = beginContinuationEvent(runtime, "adopted-compaction", undefined, "pending");
	const label = "adopted Pi threshold compaction";
	preparePendingResumeDispatch(runtime, {
		eventId: event.id,
		label,
		sendContinuation: options.sendContinuation,
		onContinuationFailed: options.onContinuationFailed,
		resumeStartTimeoutMs: options.resumeStartTimeoutMs ?? RESUME_START_TIMEOUT_MS,
		compactionProofTimeoutMs: options.compactionProofTimeoutMs ?? RESUME_START_TIMEOUT_MS,
		failureGuardKey: undefined,
		resumeOwner: options.resumeOwner,
		hostCompaction: true,
		sameRunCompaction: options.sameRunCompaction,
	});
	beginWorkingVisuals(ctx, runtime, event.id, "pi-continue adopting Pi threshold compaction");
	notify(ctx, `${label}: synthesizing handoff.`, "info");
	return event.id;
}

/** 释放当前 handoff，让同一次 Pi 事件继续使用原生摘要器。 */
export function releaseContinuationToNativeFallback(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	eventId: string,
	reason: string,
	onContinuationFailed?: (eventId: string) => void,
): boolean {
	if (!isActiveRunningContinuationEvent(runtime, eventId)) return false;
	onContinuationFailed?.(eventId);
	finishContinuationEvent(runtime, eventId, "failed", reason);
	clearPendingResumeDispatch(runtime);
	clearResumeStartTimeout(runtime);
	runtime.awaitingResumeEventId = undefined;
	runtime.compactionRunning = false;
	runtime.controlledMidRunAbortRequested = false;
	runtime.guardFailureKey = undefined;
	settleWorkingVisuals(ctx, runtime, eventId);
	return true;
}

export function releaseAdoptedNativeCompaction(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	eventId: string,
	reason: string,
	onContinuationFailed?: (eventId: string) => void,
): boolean {
	if (!isActiveRunningContinuationEvent(runtime, eventId)) return false;
	onContinuationFailed?.(eventId);
	finishContinuationEvent(runtime, eventId, "failed", reason);
	clearPendingResumeDispatch(runtime);
	clearResumeStartTimeout(runtime);
	runtime.awaitingResumeEventId = undefined;
	settleWorkingVisuals(ctx, runtime, eventId);
	notify(ctx, "pi-continue adoption failed; Pi native compaction will continue.", "warning");
	return true;
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
	runtime.controlledMidRunAbortRequested = false;
	const event = beginContinuationEvent(
		runtime,
		options.source,
		options.trigger,
		options.continueAfterComplete ? "pending" : "not-requested",
	);
	beginWorkingVisuals(ctx, runtime, event.id, "pi-continue saving handoff");
	const label = sourceLabel(options.source);
	const triggerText = options.trigger ? ` (${describeGuardTrigger(options.trigger)})` : "";
	notify(ctx, `${label}: saving handoff${triggerText}.`, "info");
	const customInstructions = mergeInstructions([
		options.instructions,
		options.trigger ? buildGuardInstructions(options.trigger) : undefined,
	]);
	const delegatedToNativeCompaction = options.deferToNativeCompaction
		&& options.continueAfterComplete
		&& options.abortActiveRun
		&& !ctx.isIdle();
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
			resumeOwner: options.resumeOwner,
			hostCompaction: true,
			sameRunCompaction: options.sameRunCompaction,
		});
	}
	function completeCompaction(): void {
		runtime.compactionRunning = false;
		runtime.controlledMidRunAbortRequested = false;
		runtime.guardFailureKey = undefined;
		if (options.continueAfterComplete) {
			markContinuationCompactionComplete(ctx, runtime, event.id);
			return;
		}
		finishContinuationEvent(runtime, event.id, "completed", undefined);
		settleWorkingVisuals(ctx, runtime, event.id);
		notify(ctx, `${label}: handoff saved.`, "info");
	}
	function failCompaction(reason: string): void {
		runtime.compactionRunning = false;
		runtime.controlledMidRunAbortRequested = false;
		if (guardKey) runtime.guardFailureKey = guardKey;
		options.onContinuationFailed?.(event.id);
		finishContinuationEvent(runtime, event.id, "failed", reason);
		clearPendingResumeDispatch(runtime);
		clearResumeStartTimeout(runtime);
		runtime.awaitingResumeEventId = undefined;
		settleWorkingVisuals(ctx, runtime, event.id);
		notify(ctx, `${label}: handoff failed: ${reason}`, "error");
	}
	try {
		if (delegatedToNativeCompaction) {
			runtime.controlledMidRunAbortRequested = true;
			ctx.abort();
			return true;
		}
		if (options.source === "mid-run-guard" && options.abortActiveRun) {
			runtime.controlledMidRunAbortRequested = true;
		}
		ctx.compact({
			customInstructions,
			onComplete: () => {
				if (!claimCompactionCallback()) return;
				completeCompaction();
			},
			onError: () => {
				if (!claimCompactionCallback()) return;
				// matching proof 已证明 handoff 落盘，延迟回调不能再把成功状态改写为失败。
				if (runtime.latestEvent?.id === event.id && runtime.latestEvent.compactionProof.status === "verified") {
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

export function markAwaitingContinuationResumeStarted(runtime: ContinuationRuntimeState): string | undefined {
	clearStaleAwaitingContinuationResume(runtime);
	const eventId = runtime.awaitingResumeEventId;
	if (!eventId) return undefined;
	if (!markContinuationResumeStarted(runtime, eventId)) return undefined;
	clearResumeStartTimeout(runtime);
	return eventId;
}

function hasUnstartedContinuationResume(runtime: ContinuationRuntimeState, eventId: string): boolean {
	const event = runtime.latestEvent;
	if (!event || event.id !== eventId) return false;
	const pending = runtime.pendingResumeDispatch;
	const pendingDispatchReady = pending?.eventId === eventId
		&& pending.compactionCompleted
		&& (event.resume.status === "not-requested" || event.resume.status === "pending");
	const awaitingPromptStart = runtime.awaitingResumeEventId === eventId && event.resume.status === "pending";
	return pendingDispatchReady || awaitingPromptStart;
}

/** 在新的普通回合真正开始时收束尚未启动的旧恢复，避免它绑定后续 Goal 迭代。 */
export function invalidateUnstartedContinuationResume(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	reason = NON_CONTINUATION_RUN_FAILURE,
): string | undefined {
	clearStaleAwaitingContinuationResume(runtime);
	const eventId = runtime.activeEventId;
	if (!eventId || !isActiveRunningContinuationEvent(runtime, eventId) || !hasUnstartedContinuationResume(runtime, eventId)) {
		return undefined;
	}
	const pending = runtime.pendingResumeDispatch?.eventId === eventId
		? runtime.pendingResumeDispatch
		: undefined;
	const awaiting = runtime.awaitingResumeStart?.eventId === eventId
		? runtime.awaitingResumeStart
		: undefined;
	const onContinuationFailed = pending?.onContinuationFailed ?? awaiting?.onContinuationFailed;
	onContinuationFailed?.(eventId);
	clearPendingResumeDispatch(runtime);
	clearResumeStartTimeout(runtime);
	runtime.awaitingResumeEventId = undefined;
	runtime.compactionRunning = false;
	runtime.controlledMidRunAbortRequested = false;
	runtime.guardFailureKey = undefined;
	if (!finishContinuationEvent(runtime, eventId, "failed", reason)) return undefined;
	settleWorkingVisuals(ctx, runtime, eventId);
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
