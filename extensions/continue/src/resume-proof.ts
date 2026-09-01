import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_PROMPT, SHAKE_CONTINUATION_PROMPT } from "./continuation-prompt.ts";
import {
	finishContinuationEvent,
	isActiveRunningContinuationEvent,
	markContinuationCompactionProofFailed,
	markContinuationCompactionProofVerified,
	markContinuationPromptSent,
	markContinuationResumePending,
	markContinuationResumeStarted,
} from "./continuation-event.ts";
import type { ContinuationEventStore, ContinuationResumeOwner } from "./types.ts";
import { settleWorkingVisuals, updateWorkingVisuals } from "./working-ui.ts";

export const PROMPT_DISPATCH_FAILURE = "Continuation resume request failed.";
export const RESUME_START_TIMEOUT_FAILURE = "Continuation resume request failed before the next run started.";
export const COMPACTION_PROOF_TIMEOUT_FAILURE = "Pi did not report a saved package-owned continuation handoff before resume.";
export const NATIVE_COMPACTION_FALLBACK_FAILURE = "Pi saved a native compaction instead of a package-owned continuation handoff.";
export const INVALID_COMPACTION_PROOF_FAILURE = "Pi saved a compaction without valid pi-continue/v4 handoff details.";
export const STALE_COMPACTION_PROOF_FAILURE = "Pi saved a continuation handoff for a different run; resume was stopped.";
export const COOPERATIVE_RESUME_REQUEST_FAILURE = "The cooperative workflow did not submit its continuation request.";
// 协作工作流若在宿主压缩返回后仍未提交提示或开启续行，应尽快释放失败状态而不是挂住整段恢复超时。
const COOPERATIVE_HANDOFF_GRACE_MS = 1_000;
// 宿主仍在运行时允许少量续期，覆盖慢速协作处理器，同时保持无响应路径有界收束。
const COOPERATIVE_HANDOFF_ACTIVE_GRACE_EXTENSIONS = 4;

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
	/** 当宿主而非 ctx.compact() 掌握压缩完成边界时为真。 */
	hostCompaction: boolean;
	resumeOwner: ContinuationResumeOwner;
	externalPromptObserved: boolean;
	/** 当压缩发生在仍在运行的宿主回合中时为真。 */
	sameRunCompaction: boolean;
	externalResumeGraceExtensions: number;
}

export interface AwaitingResumeStart {
	eventId: string;
	label: string;
	onContinuationFailed: ((eventId: string) => void) | undefined;
	resumeStartTimeoutMs: number;
	resumeOwner: ContinuationResumeOwner;
}

export interface ResumeProofRuntimeState extends ContinuationEventStore {
	compactionRunning: boolean;
	guardFailureKey: string | undefined;
	awaitingResumeEventId: string | undefined;
	awaitingResumeStart: AwaitingResumeStart | undefined;
	resumeStartTimeout: ReturnType<typeof setTimeout> | undefined;
	compactionProofTimeout: ReturnType<typeof setTimeout> | undefined;
	externalResumeTimeout: ReturnType<typeof setTimeout> | undefined;
	resumeDispatchTimer: ReturnType<typeof setTimeout> | undefined;
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
	resumeOwner?: ContinuationResumeOwner;
	hostCompaction?: boolean;
	sameRunCompaction?: boolean;
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

function clearExternalResumeTimeout(runtime: ResumeProofRuntimeState): void {
	if (!runtime.externalResumeTimeout) return;
	clearTimeout(runtime.externalResumeTimeout);
	runtime.externalResumeTimeout = undefined;
}

function clearResumeDispatchTimer(runtime: ResumeProofRuntimeState): void {
	if (!runtime.resumeDispatchTimer) return;
	clearTimeout(runtime.resumeDispatchTimer);
	runtime.resumeDispatchTimer = undefined;
}

/** 在宿主已接受扩展压缩结果后等待对应的 session_compact proof。 */
export function armContinuationCompactionProofTimeout(
	ctx: ExtensionContext,
	runtime: ResumeProofRuntimeState,
	eventId: string,
): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId || pending.proofVerified) return false;
	scheduleCompactionProofTimeout(ctx, runtime, pending);
	return true;
}

export function clearPendingResumeDispatch(runtime: ResumeProofRuntimeState): void {
	runtime.pendingResumeDispatch = undefined;
	clearCompactionProofTimeout(runtime);
	clearExternalResumeTimeout(runtime);
	clearResumeDispatchTimer(runtime);
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
		hostCompaction: options.hostCompaction ?? false,
		resumeOwner: options.resumeOwner ?? "pi-continue",
		externalPromptObserved: false,
		sameRunCompaction: options.sameRunCompaction ?? false,
		externalResumeGraceExtensions: 0,
	};
}

/** 锁定 handoff 的恢复责任，避免 Goal 已接管后又被降级为扩展自发 prompt。 */
export function setContinuationResumeOwner(
	runtime: ResumeProofRuntimeState,
	eventId: string,
	owner: ContinuationResumeOwner,
): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId) return false;
	if (pending.resumeOwner === "cooperative-workflow" && owner === "pi-continue") return true;
	pending.resumeOwner = owner;
	return true;
}

/** 记录宿主是否会在同一运行中继续请求模型，避免把合法续行误判为缺少 Goal 提示。 */
export function markContinuationCompactionRunMode(
	runtime: ResumeProofRuntimeState,
	eventId: string,
	runActive: boolean,
): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId || !pending.hostCompaction) return false;
	if (runActive) pending.sameRunCompaction = true;
	return true;
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

function scheduleExternalResumeTimeout(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, pending: PendingResumeDispatch): void {
	clearExternalResumeTimeout(runtime);
	const timeout = setTimeout(() => {
		const current = runtime.pendingResumeDispatch;
		if (
			!current
			|| current.eventId !== pending.eventId
			|| current.resumeOwner !== "cooperative-workflow"
			|| current.externalPromptObserved
		) return;
		let hostStillRunning = false;
		try {
			hostStillRunning = pending.sameRunCompaction && !ctx.isIdle();
		} catch {
			hostStillRunning = false;
		}
		if (hostStillRunning && pending.externalResumeGraceExtensions < COOPERATIVE_HANDOFF_ACTIVE_GRACE_EXTENSIONS) {
			pending.externalResumeGraceExtensions += 1;
			scheduleExternalResumeTimeout(ctx, runtime, pending);
			return;
		}
		failContinuationCompactionProof(ctx, runtime, pending.eventId, COOPERATIVE_RESUME_REQUEST_FAILURE);
	}, Math.max(0, Math.min(pending.resumeStartTimeoutMs, COOPERATIVE_HANDOFF_GRACE_MS)));
	runtime.externalResumeTimeout = timeout;
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

function dispatchCooperativeResumeIfObserved(
	ctx: ExtensionContext,
	runtime: ResumeProofRuntimeState,
	pending: PendingResumeDispatch,
	startedInCurrentRun = false,
): boolean {
	if (!pending.externalPromptObserved) {
		scheduleExternalResumeTimeout(ctx, runtime, pending);
		return false;
	}
	clearExternalResumeTimeout(runtime);
	clearCompactionProofTimeout(runtime);
	runtime.pendingResumeDispatch = undefined;
	updateWorkingVisuals(ctx, runtime, pending.eventId, "pi-continue resuming this session");
	markContinuationResumePending(runtime, pending.eventId);
	runtime.awaitingResumeEventId = pending.eventId;
	const resumeStart: AwaitingResumeStart = {
		eventId: pending.eventId,
		label: pending.label,
		onContinuationFailed: pending.onContinuationFailed,
		resumeStartTimeoutMs: pending.resumeStartTimeoutMs,
		resumeOwner: "cooperative-workflow",
	};
	runtime.awaitingResumeStart = resumeStart;
	markContinuationPromptSent(runtime, pending.eventId);
	if (startedInCurrentRun) {
		markContinuationResumeStarted(runtime, pending.eventId);
		return true;
	}
	if (ctx.isIdle() && isAwaitingResumeStartPending(runtime, pending.eventId)) {
		scheduleResumeStartTimeout(ctx, runtime, resumeStart);
	}
	return true;
}

function scheduleResumeDispatchAfterHost(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string): void {
	if (runtime.resumeDispatchTimer) return;
	const timer = setTimeout(() => {
		runtime.resumeDispatchTimer = undefined;
		dispatchIfReady(ctx, runtime, eventId);
	}, 0);
	runtime.resumeDispatchTimer = timer;
	unrefTimer(timer);
}

function queueResumeDispatch(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId || !pending.compactionCompleted || !pending.proofVerified) return false;
	if (pending.hostCompaction && !pending.sameRunCompaction) {
		clearCompactionProofTimeout(runtime);
		scheduleResumeDispatchAfterHost(ctx, runtime, eventId);
		return true;
	}
	return dispatchIfReady(ctx, runtime, eventId, pending.sameRunCompaction);
}

function dispatchIfReady(
	ctx: ExtensionContext,
	runtime: ResumeProofRuntimeState,
	eventId: string,
	startedInCurrentRun = false,
): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId || !pending.compactionCompleted || !pending.proofVerified) return false;
	if (!isActiveRunningContinuationEvent(runtime, eventId)) return false;
	if (pending.resumeOwner === "cooperative-workflow") return dispatchCooperativeResumeIfObserved(ctx, runtime, pending, startedInCurrentRun);
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
		resumeOwner: "pi-continue",
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

/** 接受 Goal 已经排队的同会话 continuation，扩展只负责把它纳入自己的 proof 闭环。 */
export function observeCooperativeContinuationPrompt(
	ctx: ExtensionContext,
	runtime: ResumeProofRuntimeState,
	eventId: string,
): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId || pending.resumeOwner !== "cooperative-workflow") return false;
	if (!isActiveRunningContinuationEvent(runtime, eventId)) return false;
	pending.externalPromptObserved = true;
	if (!pending.compactionCompleted || !pending.proofVerified) return true;
	queueResumeDispatch(ctx, runtime, eventId);
	return true;
}

/** 识别宿主压缩后的同回合续行；此路径不应等待 Goal 再提交一条重复提示。 */
export function observeCooperativeContinuationTurn(
	ctx: ExtensionContext,
	runtime: ResumeProofRuntimeState,
	eventId: string,
): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (
		!pending
		|| pending.eventId !== eventId
		|| pending.resumeOwner !== "cooperative-workflow"
		|| !pending.sameRunCompaction
		|| pending.externalPromptObserved
		|| runtime.awaitingResumeEventId === eventId
		|| ctx.isIdle()
	) return false;
	if (!isActiveRunningContinuationEvent(runtime, eventId)) return false;
	pending.externalPromptObserved = true;
	if (!pending.compactionCompleted || !pending.proofVerified) return true;
	clearResumeDispatchTimer(runtime);
	dispatchIfReady(ctx, runtime, eventId, true);
	return true;
}

export function markContinuationCompactionComplete(ctx: ExtensionContext, runtime: ResumeProofRuntimeState, eventId: string): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId) return false;
	if (pending.compactionCompleted) return pending.proofVerified
		? queueResumeDispatch(ctx, runtime, eventId)
		: true;
	pending.compactionCompleted = true;
	if (pending.proofVerified) return queueResumeDispatch(ctx, runtime, eventId);
	updateWorkingVisuals(ctx, runtime, eventId, "pi-continue verifying saved handoff");
	scheduleCompactionProofTimeout(ctx, runtime, pending);
	return true;
}

/**
 * 由宿主 session_compact 事件确认保存完成；延迟一个任务再投递，避开手动压缩控制器尚未清理的窗口。
 */
export function markContinuationCompactionCompleteFromHost(
	ctx: ExtensionContext,
	runtime: ResumeProofRuntimeState,
	eventId: string,
): boolean {
	const pending = runtime.pendingResumeDispatch;
	if (!pending || pending.eventId !== eventId || !pending.hostCompaction) return false;
	return markContinuationCompactionComplete(ctx, runtime, eventId);
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
	return queueResumeDispatch(ctx, runtime, eventId);
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
