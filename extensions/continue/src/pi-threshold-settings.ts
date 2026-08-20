import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { patchPiCompactionSettings, readPiCompactionSettingsForScope } from "./pi-settings.ts";
import type { ConfigScope, ContinuationConfig } from "./types.ts";
import { resolveCompactionThreshold } from "./threshold.ts";

function resolveContextWindow(ctx: ExtensionCommandContext): number | undefined {
	const modelWindow = ctx.model?.contextWindow;
	if (modelWindow !== undefined && Number.isFinite(modelWindow) && modelWindow > 0) return modelWindow;
	const usageWindow = ctx.getContextUsage()?.contextWindow;
	return usageWindow !== undefined && Number.isFinite(usageWindow) && usageWindow > 0 ? usageWindow : undefined;
}

/** Render the selected-scope handoff trigger as the single human-facing token count. */
export function renderHandoffTrigger(
	ctx: ExtensionCommandContext,
	config: Pick<ContinuationConfig, "compactionThresholdMode" | "compactionThresholdPercent">,
	scope: ConfigScope,
	projectRoot: string,
): string {
	const compaction = readPiCompactionSettingsForScope(scope, projectRoot);
	const threshold = resolveCompactionThreshold(config, compaction, resolveContextWindow(ctx));
	if (!threshold) return "unavailable";
	if (threshold.mode === "percentage") {
		return `${threshold.percentage}% (${threshold.thresholdTokens.toLocaleString()} tokens for this model)`;
	}
	return `${threshold.thresholdTokens.toLocaleString()} tokens`;
}

function parseTokenCountInput(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.replaceAll(",", "").replaceAll("_", "");
	if (!/^\d+$/.test(normalized)) return undefined;
	const parsed = Number.parseInt(normalized, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function chooseHandoffTriggerReserveTokens(
	ctx: ExtensionCommandContext,
	scope: ConfigScope,
	projectRoot: string,
): Promise<number | null | undefined> {
	const contextWindow = resolveContextWindow(ctx);
	const compaction = readPiCompactionSettingsForScope(scope, projectRoot);
	const threshold = resolveCompactionThreshold(
		{ compactionThresholdMode: "reserve-tokens", compactionThresholdPercent: 90 },
		compaction,
		contextWindow,
	);
	const options = [
		`Keep current (${threshold ? `${threshold.thresholdTokens.toLocaleString()} tokens` : "unavailable"})`,
		contextWindow === undefined ? undefined : "Set trigger token count",
		"Use inherited/default trigger for this scope",
	].filter((option): option is string => option !== undefined);
	const choice = await ctx.ui.select("Handoff trigger", options);
	if (!choice || choice.startsWith("Keep current")) return undefined;
	if (choice === "Use inherited/default trigger for this scope") return null;
	if (choice === "Set trigger token count") {
		const entered = await ctx.ui.input("Handoff trigger", "token count, for example 96000");
		const thresholdTokens = parseTokenCountInput(entered);
		if (thresholdTokens === undefined || contextWindow === undefined || thresholdTokens >= contextWindow) {
			ctx.ui.notify("Handoff trigger must be a positive integer below the context window.", "warning");
			return undefined;
		}
		return contextWindow - thresholdTokens;
	}
	return undefined;
}

/** Run the trigger picker and persist a scoped Pi reserveTokens override only after an explicit selection. */
export async function updateHandoffTriggerFromDialog(
	ctx: ExtensionCommandContext,
	scope: ConfigScope,
	projectRoot: string,
): Promise<void> {
	const reserveTokens = await chooseHandoffTriggerReserveTokens(ctx, scope, projectRoot);
	if (reserveTokens === undefined) return;
	await patchPiCompactionSettings(scope, projectRoot, { reserveTokens });
	ctx.ui.notify(
		reserveTokens === null ? `Removed ${scope} handoff trigger override` : `Updated ${scope} handoff trigger`,
		"info",
	);
}
