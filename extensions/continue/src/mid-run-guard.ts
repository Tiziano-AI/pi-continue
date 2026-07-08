import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadContinuationConfig } from "./config.ts";
import { normalizeCompactionPreparation, type ContinuationCompactionPreparation } from "./compaction-preparation.ts";
import { readEffectivePiCompactionSettings } from "./pi-settings.ts";
import { loadPiInternals } from "./pi-internals.ts";
import { resolveProjectContext } from "./project.ts";
import { sendContinuationPrompt } from "./prompt-dispatch.ts";
import { startContinuationCompaction, type ContinuationRuntimeState } from "./runtime.ts";
import { endsWithCompleteToolResultBatch } from "./tool-batches.ts";
import type {
	ContextUsageEstimateSnapshot,
	ContinuationConfig,
	MidRunGuardTrigger,
	PiCompactionSettings,
} from "./types.ts";

export interface MidRunGuardDecisionInput {
	config: ContinuationConfig;
	piSettings: PiCompactionSettings;
	contextWindow: number | undefined;
	estimate: ContextUsageEstimateSnapshot;
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
		trigger.contextWindow,
		trigger.reserveTokens,
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

/** Decide whether a pre-provider context belongs to a completed assistant/tool-result loop. */
export function shouldEvaluateMidRunContext(messages: unknown[]): boolean {
	return endsWithCompleteToolResultBatch(messages);
}

/** Decide whether the package must stop before Pi sends another provider request. */
export function decideMidRunGuardTrigger(input: MidRunGuardDecisionInput): MidRunGuardTrigger | undefined {
	if (!input.config.enabled || !input.config.midRunGuardEnabled || !input.piSettings.enabled) return undefined;
	if (!hasUsableContextWindow(input.contextWindow, input.piSettings.reserveTokens)) return undefined;
	const thresholdTokens = input.contextWindow - input.piSettings.reserveTokens;
	if (input.estimate.tokens <= thresholdTokens) return undefined;
	return {
		estimatedTokens: input.estimate.tokens,
		thresholdTokens,
		contextWindow: input.contextWindow,
		reserveTokens: input.piSettings.reserveTokens,
		usageTokens: input.estimate.usageTokens,
		trailingTokens: input.estimate.trailingTokens,
		lastUsageIndex: input.estimate.lastUsageIndex,
	};
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
		sendContinuation: (prompt) => sendContinuationPrompt(pi, prompt),
		onContinuationFailed,
	});
}
