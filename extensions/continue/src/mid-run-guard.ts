import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadContinuationConfig } from "./config.ts";
import { normalizeCompactionPreparation, type ContinuationCompactionPreparation } from "./compaction-preparation.ts";
import { readEffectivePiCompactionSettings } from "./pi-settings.ts";
import { loadPiInternals } from "./pi-internals.ts";
import { resolveProjectContext } from "./project.ts";
import { sendContinuationPrompt } from "./prompt-dispatch.ts";
import { startContinuationCompaction, type ContinuationRuntimeState } from "./runtime.ts";
import {
	hasCrossedPiNativeCompactionThreshold,
	hasReachedCompactionThreshold,
	resolveCompactionThreshold,
} from "./threshold.ts";
import { endsWithCompleteToolResultBatch } from "./tool-batches.ts";
import type {
	ContextUsageEstimateSnapshot,
	ContinuationConfig,
	MidRunGuardTrigger,
	NativeCompactionAdoptionCheckpoint,
	PiCompactionSettings,
} from "./types.ts";

export interface MidRunGuardDecisionInput {
	config: ContinuationConfig;
	piSettings: PiCompactionSettings;
	contextWindow: number | undefined;
	estimate: ContextUsageEstimateSnapshot;
}

export interface NativeCompactionAdoptionDecisionInput {
	config: ContinuationConfig;
	checkpoint: NativeCompactionAdoptionCheckpoint | undefined;
	reason: string | undefined;
	willRetry: boolean | undefined;
	runActive: boolean;
	hasPendingMessages: boolean;
	contextWindow: number | undefined;
	preparation: unknown | undefined;
	branchEntries: unknown[];
	piSettings: PiCompactionSettings;
	estimateTokens: (message: unknown) => number;
	now?: number;
}

interface BranchEntryRecord {
	type?: unknown;
	message?: unknown;
	customType?: unknown;
	content?: unknown;
	display?: unknown;
	details?: unknown;
	timestamp?: unknown;
	summary?: unknown;
	fromId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasUsableContextWindow(contextWindow: number | undefined, reserveTokens: number): contextWindow is number {
	return contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > reserveTokens;
}

function buildNoCompactableGuardKey(trigger: MidRunGuardTrigger, piSettings: PiCompactionSettings): string {
	return [
		trigger.mode,
		trigger.contextWindow,
		trigger.mode === "reserve-tokens" ? trigger.reserveTokens : trigger.percentage,
		trigger.thresholdTokens,
		piSettings.keepRecentTokens,
	].join(":");
}

function notifyNoCompactableSession(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	trigger: MidRunGuardTrigger,
	piSettings: PiCompactionSettings,
): void {
	const key = buildNoCompactableGuardKey(trigger, piSettings);
	if (runtime.lastNoCompactableGuardKey === key) return;
	runtime.lastNoCompactableGuardKey = key;
	if (!ctx.hasUI) return;
	ctx.ui.notify(
		"automatic continuation skipped: Pi has no compactable session history yet; the over-threshold context is still within the recent keep window or static prompt overhead.",
		"warning",
	);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasFileOperationSets(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return value.read instanceof Set && value.written instanceof Set && value.edited instanceof Set;
}

function isPiCompactionSettings(value: unknown): value is PiCompactionSettings {
	if (!isRecord(value)) return false;
	return typeof value.enabled === "boolean"
		&& isFiniteNumber(value.reserveTokens)
		&& isFiniteNumber(value.keepRecentTokens);
}

function isContinuationCompactionPreparation(value: unknown): value is ContinuationCompactionPreparation {
	if (!isRecord(value)) return false;
	return typeof value.firstKeptEntryId === "string"
		&& Array.isArray(value.messagesToSummarize)
		&& Array.isArray(value.turnPrefixMessages)
		&& typeof value.isSplitTurn === "boolean"
		&& isFiniteNumber(value.tokensBefore)
		&& hasFileOperationSets(value.fileOps)
		&& isPiCompactionSettings(value.settings);
}

function messageFromBranchEntry(entry: unknown): unknown | undefined {
	if (!isRecord(entry)) return undefined;
	const record = entry as BranchEntryRecord;
	if (record.type === "message") return record.message;
	if (record.type === "custom_message") {
		return {
			role: "custom",
			customType: record.customType,
			content: record.content,
			display: record.display,
			details: record.details,
			timestamp: record.timestamp,
		};
	}
	if (record.type === "branch_summary" && typeof record.summary === "string" && typeof record.fromId === "string") {
		return {
			role: "branchSummary",
			summary: record.summary,
			fromId: record.fromId,
			timestamp: record.timestamp,
		};
	}
	return undefined;
}

function estimateBranchTokens(branchEntries: unknown[], estimateTokens: (message: unknown) => number): number {
	let total = 0;
	for (const entry of branchEntries) {
		const message = messageFromBranchEntry(entry);
		if (!message) continue;
		const tokens = estimateTokens(message);
		if (Number.isFinite(tokens) && tokens > 0) total += tokens;
	}
	return total;
}

export function hasNativeCompactionPreparation(
	preparation: unknown | undefined,
	branchEntries: unknown[],
	piSettings: PiCompactionSettings,
	estimateTokens: (message: unknown) => number,
): boolean {
	if (!isContinuationCompactionPreparation(preparation)) return false;
	if (preparation.messagesToSummarize.length > 0) return true;
	if (preparation.turnPrefixMessages.length > 0) return true;
	if (estimateBranchTokens(branchEntries, estimateTokens) <= piSettings.keepRecentTokens) return false;
	const normalized = normalizeCompactionPreparation(preparation, branchEntries);
	return normalized.messagesToSummarize.length > 0 || normalized.turnPrefixMessages.length > 0;
}

const NATIVE_ADOPTION_CHECKPOINT_TTL_MS = 30_000;

/** 只接受紧随可验证回合边界的 Pi 阈值压缩，排除手动与恢复压缩。 */
export function decideNativeCompactionAdoption(input: NativeCompactionAdoptionDecisionInput): boolean {
	if (!input.config.enabled || !input.config.adoptNativeCompaction || !input.piSettings.enabled) return false;
	if (!input.checkpoint) return false;
	const validBoundary = input.checkpoint.stopReason === "stop"
		|| (input.checkpoint.stopReason === "toolUse" && input.checkpoint.boundary === "complete-tool-result-batch");
	if (!validBoundary) return false;
	if (input.reason !== "threshold" || input.willRetry !== false) return false;
	if (!input.runActive || input.hasPendingMessages) return false;
	if (!hasUsableContextWindow(input.contextWindow, input.piSettings.reserveTokens)) return false;
	const checkpointAge = (input.now ?? Date.now()) - input.checkpoint.openedAt;
	if (checkpointAge < 0 || checkpointAge > NATIVE_ADOPTION_CHECKPOINT_TTL_MS) return false;
	return hasNativeCompactionPreparation(
		input.preparation,
		input.branchEntries,
		input.piSettings,
		input.estimateTokens,
	);
}

/** Decide whether a pre-provider context belongs to a completed assistant/tool-result loop. */
export function shouldEvaluateMidRunContext(messages: unknown[]): boolean {
	return endsWithCompleteToolResultBatch(messages);
}

/** Decide whether the package must stop before Pi sends another provider request. */
export function decideMidRunGuardTrigger(input: MidRunGuardDecisionInput): MidRunGuardTrigger | undefined {
	if (!input.config.enabled || !input.config.midRunGuardEnabled || !input.piSettings.enabled) return undefined;
	const threshold = resolveCompactionThreshold(input.config, input.piSettings, input.contextWindow);
	if (!threshold || !hasReachedCompactionThreshold(input.estimate.tokens, threshold)) return undefined;
	return {
		...threshold,
		estimatedTokens: input.estimate.tokens,
		usageTokens: input.estimate.usageTokens,
		trailingTokens: input.estimate.trailingTokens,
		lastUsageIndex: input.estimate.lastUsageIndex,
	};
}

/** 只有宿主原生阈值已达到时才交给回合结束压缩，较早的自定义百分比仍走显式压缩。 */
export function shouldDelegateMidRunCompactionToNative(
	trigger: MidRunGuardTrigger,
	piSettings: PiCompactionSettings,
): boolean {
	if (
		!Number.isSafeInteger(piSettings.reserveTokens)
		|| piSettings.reserveTokens <= 0
		|| trigger.contextWindow <= piSettings.reserveTokens
	) {
		return false;
	}
	const nativeThresholdTokens = trigger.contextWindow - piSettings.reserveTokens;
	return trigger.thresholdTokens > nativeThresholdTokens
		|| trigger.estimatedTokens > nativeThresholdTokens;
}

async function startResolvedGuard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	trigger: MidRunGuardTrigger,
	piSettings: PiCompactionSettings,
	internals: Awaited<ReturnType<typeof loadPiInternals>>,
	onContinuationFailed?: (eventId: string) => void,
): Promise<void> {
	// 自动守卫共享当前 handoff 的生命周期，重复事件不应再次中止运行或重复告警。
	if (runtime.compactionRunning || runtime.pendingResumeDispatch !== undefined) return;
	const branchEntries = ctx.sessionManager.getBranch();
	const preparation = internals.prepareCompaction(branchEntries, piSettings);
	if (!hasNativeCompactionPreparation(preparation, branchEntries, piSettings, internals.estimateTokens)) {
		notifyNoCompactableSession(ctx, runtime, trigger, piSettings);
		return;
	}
	runtime.lastNoCompactableGuardKey = undefined;
	startContinuationCompaction(ctx, runtime, {
		source: "mid-run-guard",
		instructions: undefined,
		trigger,
		abortActiveRun: true,
		continueAfterComplete: true,
		deferToNativeCompaction: shouldDelegateMidRunCompactionToNative(trigger, piSettings),
		sendContinuation: (prompt) => sendContinuationPrompt(pi, prompt),
		onContinuationFailed,
	});
}

/** Evaluate the awaited pre-provider guard after a complete assistant/tool-result batch. */
export async function runMidRunGuard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	messages: unknown[],
	onContinuationFailed?: (eventId: string) => void,
): Promise<void> {
	if (!shouldEvaluateMidRunContext(messages) || !ctx.model) return;
	const initialProjectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId());
	const config = loadContinuationConfig(initialProjectContext.projectRoot);
	if (!config.enabled || !config.midRunGuardEnabled) return;
	const piSettings = readEffectivePiCompactionSettings(initialProjectContext.projectRoot);
	const internals = await loadPiInternals();
	const estimate = internals.estimateContextTokens(messages);
	const trigger = decideMidRunGuardTrigger({
		config,
		piSettings,
		contextWindow: ctx.model.contextWindow,
		estimate,
	});
	if (!trigger) return;
	await startResolvedGuard(pi, ctx, runtime, trigger, piSettings, internals, onContinuationFailed);
}

/** 百分比阈值不依赖共享 reserveTokens，并在 Pi 原生阈值更晚时于回合边界主动触发。 */
export async function runPercentageThresholdGuard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	onContinuationFailed?: (eventId: string) => void,
): Promise<void> {
	if (!ctx.model) return;
	const initialProjectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId());
	const config = loadContinuationConfig(initialProjectContext.projectRoot);
	if (!config.enabled || config.compactionThresholdMode !== "percentage") return;
	const piSettings = readEffectivePiCompactionSettings(initialProjectContext.projectRoot);
	if (!piSettings.enabled) return;
	const threshold = resolveCompactionThreshold(config, piSettings, ctx.model.contextWindow);
	if (!threshold || threshold.mode !== "percentage") return;
	const nativeThresholdTokens = ctx.model.contextWindow - piSettings.reserveTokens;
	if (threshold.thresholdTokens > nativeThresholdTokens) return;
	const contextTokens = ctx.getContextUsage()?.tokens;
	if (contextTokens === null || contextTokens === undefined || !Number.isFinite(contextTokens)) return;
	if (!hasReachedCompactionThreshold(contextTokens, threshold)) return;
	if (hasCrossedPiNativeCompactionThreshold(contextTokens, piSettings, ctx.model.contextWindow)) return;
	const trigger: MidRunGuardTrigger = {
		...threshold,
		estimatedTokens: contextTokens,
		usageTokens: contextTokens,
		trailingTokens: 0,
		lastUsageIndex: null,
	};
	const internals = await loadPiInternals();
	await startResolvedGuard(pi, ctx, runtime, trigger, piSettings, internals, onContinuationFailed);
}
