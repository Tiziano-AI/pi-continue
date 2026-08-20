import type {
	ContinuationConfig,
	PiCompactionSettings,
	ResolvedCompactionThreshold,
} from "./types.ts";

function isUsableContextWindow(contextWindow: number | undefined): contextWindow is number {
	return contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0;
}

/** 每次使用当前会话模型重新解析，避免跨会话改写共享的 Pi 预留量。 */
export function resolveCompactionThreshold(
	config: Pick<ContinuationConfig, "compactionThresholdMode" | "compactionThresholdPercent">,
	piSettings: Pick<PiCompactionSettings, "reserveTokens">,
	contextWindow: number | undefined,
): ResolvedCompactionThreshold | undefined {
	if (!isUsableContextWindow(contextWindow)) return undefined;
	if (config.compactionThresholdMode === "percentage") {
		const percentage = config.compactionThresholdPercent;
		if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100) return undefined;
		const thresholdTokens = Math.floor(contextWindow * percentage / 100);
		if (thresholdTokens <= 0 || thresholdTokens >= contextWindow) return undefined;
		return { mode: "percentage", thresholdTokens, contextWindow, percentage };
	}
	if (!Number.isSafeInteger(piSettings.reserveTokens) || piSettings.reserveTokens <= 0 || contextWindow <= piSettings.reserveTokens) {
		return undefined;
	}
	return {
		mode: "reserve-tokens",
		thresholdTokens: contextWindow - piSettings.reserveTokens,
		contextWindow,
		reserveTokens: piSettings.reserveTokens,
	};
}

/** 固定预留量沿用 Pi 的严格大于语义；百分比在整数阈值处立即生效。 */
export function hasReachedCompactionThreshold(tokens: number, threshold: ResolvedCompactionThreshold): boolean {
	return threshold.mode === "reserve-tokens"
		? tokens > threshold.thresholdTokens
		: tokens >= threshold.thresholdTokens;
}

export function describeCompactionThreshold(threshold: ResolvedCompactionThreshold): string {
	if (threshold.mode === "percentage") {
		return `${threshold.percentage}% (${threshold.thresholdTokens.toLocaleString()} of ${threshold.contextWindow.toLocaleString()} tokens)`;
	}
	return `${threshold.thresholdTokens.toLocaleString()} tokens (${threshold.reserveTokens.toLocaleString()} reserved)`;
}

/** 用量未知时保留 Pi 原生行为，避免因估算缺失而阻断溢出恢复。 */
export function shouldDeferNativeThresholdCompaction(
	config: Pick<ContinuationConfig, "enabled" | "compactionThresholdMode" | "compactionThresholdPercent">,
	piSettings: Pick<PiCompactionSettings, "enabled" | "reserveTokens">,
	contextWindow: number | undefined,
	contextTokens: number | null | undefined,
): boolean {
	if (!config.enabled || config.compactionThresholdMode !== "percentage" || !piSettings.enabled) return false;
	if (contextTokens === null || contextTokens === undefined || !Number.isFinite(contextTokens)) return false;
	const threshold = resolveCompactionThreshold(config, piSettings, contextWindow);
	return threshold?.mode === "percentage" && !hasReachedCompactionThreshold(contextTokens, threshold);
}
