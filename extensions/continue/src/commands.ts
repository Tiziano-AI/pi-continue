import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadHistoryPromptAssets } from "./assets.ts";
import { normalizeCompactionPreparation, snapshotFileOperations, stripCompactionPreparationMessages, type ContinuationCompactionPreparation } from "./compaction-preparation.ts";
import { CONTINUATION_PROMPT } from "./continuation-prompt.ts";
import { loadContinuationConfig, loadScopeConfig, patchContinuationConfig, resetContinuationConfig } from "./config.ts";
import { showLatestContinuationLedger, type ContinuationLedgerOverlayController } from "./ledger-viewer.ts";
import { showScrollableTextOverlay } from "./text-viewer.ts";
import { readEffectivePiCompactionSettings } from "./pi-settings.ts";
import { renderHandoffTrigger, updateHandoffTriggerFromDialog } from "./pi-threshold-settings.ts";
import { loadPiInternals } from "./pi-internals.ts";
import { isContinuationPromptUserMessage } from "./prompt-dispatch.ts";
import { compileHistoryPrompt, renderPromptPreview } from "./prompt.ts";
import { resolveProjectContext } from "./project.ts";
import { resolveSummarizerModel } from "./model-settings.ts";
import { getLatestContinuationEvent, getLatestContinuationLedger, type ContinuationRuntimeState } from "./runtime.ts";
import { renderStatus } from "./status.ts";
import { commandHasUi } from "./ui.ts";
import type { ConfigScope, ContinuationConfig, PreviewPayload } from "./types.ts";

interface ParsedScope {
	scope: ConfigScope;
	error: string | undefined;
}

function parseScope(args: string | undefined, command: "settings" | "reset"): ParsedScope {
	const trimmed = args?.trim().toLowerCase() ?? "";
	if (trimmed.length === 0) return { scope: "project", error: undefined };
	if (trimmed === "project" || trimmed === "global") return { scope: trimmed, error: undefined };
	return { scope: "project", error: `Usage: /continue ${command} [project|global]` };
}

function joinArgs(args: string | undefined): string | undefined {
	const trimmed = args?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

async function requireUi(ctx: ExtensionCommandContext): Promise<boolean> {
	return commandHasUi(ctx);
}

async function buildPromptPreviewPayload(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	customInstructions: string | undefined,
): Promise<PreviewPayload | undefined> {
	const sessionId = ctx.sessionManager.getSessionId();
	const initialProjectContext = await resolveProjectContext(pi, ctx.cwd, sessionId);
	const config = loadContinuationConfig(initialProjectContext.projectRoot);
	const projectContext = await resolveProjectContext(pi, ctx.cwd, sessionId, config.agentGuidePath);
	const piCompactionSettings = readEffectivePiCompactionSettings(projectContext.projectRoot);
	const internals = await loadPiInternals();
	const branchEntries = ctx.sessionManager.getBranch();
	const rawPreparation = internals.prepareCompaction(branchEntries, piCompactionSettings) as ContinuationCompactionPreparation | undefined;
	if (!rawPreparation) return undefined;
	const preparation = stripCompactionPreparationMessages(
		normalizeCompactionPreparation(rawPreparation, branchEntries),
		(message) => isContinuationPromptUserMessage(message, CONTINUATION_PROMPT),
	);
	const scenario = preparation.previousSummary ? "update" : "initial";
	const historyTranscript = internals.serializeConversation(internals.convertToLlm(preparation.messagesToSummarize));
	const turnPrefixTranscript = preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0
		? internals.serializeConversation(internals.convertToLlm(preparation.turnPrefixMessages))
		: undefined;
	const fileOps = snapshotFileOperations(preparation.fileOps);
	const historyAssets = loadHistoryPromptAssets(projectContext.projectRoot, config.promptOverridePolicy, scenario);
	const history = compileHistoryPrompt(historyAssets, {
		scenario,
		projectRoot: projectContext.projectRoot,
		agentGuidePath: projectContext.agentGuidePath,
		existingAgentGuide: projectContext.existingAgentGuide,
		previousSummary: preparation.previousSummary,
		historyTranscript,
		turnPrefixTranscript,
		customInstructions,
		fileOps,
	});
	return {
		history,
		scenario,
		isSplitTurn: preparation.isSplitTurn,
	};
}

async function showText(ctx: ExtensionCommandContext, title: string, content: string): Promise<void> {
	if (!(await requireUi(ctx))) return;
	const shown = await showScrollableTextOverlay(ctx, { title, content });
	if (!shown) ctx.ui.notify(`${title} panel cannot open in this Pi mode.`, "warning");
}

async function chooseModel(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const options = ["Inherit current model", ...ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`), "Enter provider/model manually"];
	const selected = await ctx.ui.select("Handoff model", options);
	if (!selected) return undefined;
	if (selected === "Inherit current model") return "inherit";
	if (selected === "Enter provider/model manually") {
		const entered = await ctx.ui.input("Handoff model", "provider/model or inherit");
		return entered?.trim();
	}
	return selected;
}

const ALL_REASONING_OPTIONS: readonly ContinuationConfig["reasoning"][] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];

/** Return operator-selectable reasoning levels, hiding levels unsupported by the resolved summarizer model. */
export function getReasoningOptionsForModel(model: Model<Api> | undefined): ContinuationConfig["reasoning"][] {
	if (!model) return [...ALL_REASONING_OPTIONS];
	return ["inherit", ...getSupportedThinkingLevels(model)];
}

async function chooseReasoning(ctx: ExtensionCommandContext, config: ContinuationConfig): Promise<ContinuationConfig["reasoning"] | undefined> {
	const selected = await ctx.ui.select("Reasoning level", getReasoningOptionsForModel(resolveSummarizerModel(ctx, config)));
	return selected as ContinuationConfig["reasoning"] | undefined;
}


async function chooseTokenOverride(
	ctx: ExtensionCommandContext,
	title: string,
	current: number | null,
): Promise<number | null | undefined> {
	const choice = await ctx.ui.select(title, ["Use Pi default", `Keep current (${current ?? "Pi default"})`, "Enter token limit"]);
	if (!choice) return undefined;
	if (choice === "Use Pi default") return null;
	if (choice.startsWith("Keep current")) return current;
	const entered = await ctx.ui.input(title, "positive integer or blank to cancel");
	if (!entered) return undefined;
	const parsed = Number.parseInt(entered, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function choosePositiveInteger(
	ctx: ExtensionCommandContext,
	title: string,
	current: number,
): Promise<number | undefined> {
	const choice = await ctx.ui.select(title, [`Keep current (${current})`, "Enter positive integer"]);
	if (!choice || choice.startsWith("Keep current")) return undefined;
	const entered = await ctx.ui.input(title, "positive integer or blank to cancel");
	if (!entered) return undefined;
	const parsed = Number.parseInt(entered, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const FIXED_RESERVE_MODE_LABEL = "Fixed reserve tokens";
const PERCENTAGE_MODE_LABEL = "Percentage of current model";

function thresholdModeLabel(config: ContinuationConfig): string {
	return config.compactionThresholdMode === "percentage" ? PERCENTAGE_MODE_LABEL : FIXED_RESERVE_MODE_LABEL;
}

async function chooseCompactionThresholdMode(ctx: ExtensionCommandContext): Promise<ContinuationConfig["compactionThresholdMode"] | undefined> {
	const selected = await ctx.ui.select("Compaction threshold mode", [FIXED_RESERVE_MODE_LABEL, PERCENTAGE_MODE_LABEL]);
	if (selected === FIXED_RESERVE_MODE_LABEL) return "reserve-tokens";
	if (selected === PERCENTAGE_MODE_LABEL) return "percentage";
	return undefined;
}

async function chooseCompactionThresholdPercent(ctx: ExtensionCommandContext, current: number): Promise<number | undefined> {
	const choice = await ctx.ui.select("Handoff trigger", [`Keep current (${current}%)`, "Set context percentage"]);
	if (!choice || choice.startsWith("Keep current")) return undefined;
	const entered = await ctx.ui.input("Handoff trigger", "percentage above 0 and below 100, for example 90");
	const normalized = entered?.trim().replace(/%$/, "");
	if (!normalized || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
		ctx.ui.notify("Handoff trigger must be a number above 0 and below 100.", "warning");
		return undefined;
	}
	const parsed = Number(normalized);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
		ctx.ui.notify("Handoff trigger must be a number above 0 and below 100.", "warning");
		return undefined;
	}
	return parsed;
}

const CONFIG_KEYS = [
	"enabled",
	"summarizerModel",
	"reasoning",
	"historyMaxTokens",
	"synthesisTimeoutMs",
	"continuationArtifactMode",
	"agentGuidePath",
	"agentGuideSyncMode",
	"midRunGuardEnabled",
	"adoptNativeCompaction",
	"compactionThresholdMode",
	"compactionThresholdPercent",
	"appendCompactionMetadata",
	"appendReadFileTags",
	"appendModifiedFileTags",
	"promptOverridePolicy",
	"showAfterCompact",
] as const;

function setConfigPatchValue<Key extends keyof ContinuationConfig>(patch: Partial<ContinuationConfig>, key: Key, value: ContinuationConfig[Key]): void {
	patch[key] = value;
}

function diffConfig(previous: ContinuationConfig, next: ContinuationConfig): Partial<ContinuationConfig> {
	const patch: Partial<ContinuationConfig> = {};
	for (const key of CONFIG_KEYS) {
		if (previous[key] !== next[key]) setConfigPatchValue(patch, key, next[key]);
	}
	return patch;
}

async function updateSetting(
	scope: ConfigScope,
	projectRoot: string,
	config: ContinuationConfig,
	mutator: (current: ContinuationConfig) => Promise<ContinuationConfig | undefined>,
): Promise<ContinuationConfig> {
	const next = await mutator(config);
	if (!next) return config;
	const patch = diffConfig(config, next);
	await patchContinuationConfig(scope, projectRoot, patch);
	return next;
}

/** Edit scoped config in the TUI. */
export async function runSettingsDialog(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string | undefined): Promise<void> {
	if (!(await requireUi(ctx))) return;
	const projectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId());
	const parsedScope = parseScope(args, "settings");
	if (parsedScope.error) {
		ctx.ui.notify(parsedScope.error, "warning");
		return;
	}
	let scope = parsedScope.scope;
	let config = loadScopeConfig(scope, projectContext.projectRoot);
	while (true) {
		const selected = await ctx.ui.select("Continuation settings", [
			`Settings scope: ${scope}`,
			`Enabled: ${config.enabled ? "yes" : "no"}`,
			`Handoff model: ${config.summarizerModel}`,
			`Reasoning: ${config.reasoning}`,
			`History output budget: ${config.historyMaxTokens ?? "Pi default"}`,
			`Synthesis timeout: ${config.synthesisTimeoutMs} ms`,
			`Continuation artifact: ${config.continuationArtifactMode}`,
			`Agent guide path: ${config.agentGuidePath}`,
			`Agent guide updates: ${config.agentGuideSyncMode} (full replacement only)`,
			`Automatic mid-run continuation: ${config.midRunGuardEnabled ? "yes" : "no"}`,
			`Adopt native threshold compaction: ${config.adoptNativeCompaction ? "yes" : "no"}`,
			`Compaction threshold mode: ${thresholdModeLabel(config)}`,
			`Handoff trigger: ${renderHandoffTrigger(ctx, config, scope, projectContext.projectRoot)}`,
			`Append compaction metadata: ${config.appendCompactionMetadata ? "yes" : "no"}`,
			`Append read file tags: ${config.appendReadFileTags ? "yes" : "no"}`,
			`Append modified file tags: ${config.appendModifiedFileTags ? "yes" : "no"}`,
			`Prompt override policy: ${config.promptOverridePolicy}`,
			`Show brief after compaction: ${config.showAfterCompact ? "yes" : "no"}`,
			`Reset ${scope} settings`,
			"Done",
		]);
		if (!selected || selected === "Done") return;
		if (selected.startsWith("Settings scope:")) {
			scope = scope === "project" ? "global" : "project";
			config = loadScopeConfig(scope, projectContext.projectRoot);
			ctx.ui.notify(`Editing ${scope} continuation settings`, "info");
			continue;
		}
		if (selected.startsWith("Enabled:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => ({
				...current,
				enabled: !current.enabled,
			}));
			continue;
		}
		if (selected.startsWith("Handoff model:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await chooseModel(ctx);
				return next ? { ...current, summarizerModel: next } : undefined;
			});
			continue;
		}
		if (selected.startsWith("Reasoning:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await chooseReasoning(ctx, current);
				return next ? { ...current, reasoning: next } : undefined;
			});
			continue;
		}
		if (selected.startsWith("History output budget:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await chooseTokenOverride(ctx, "History output budget", current.historyMaxTokens);
				return next !== undefined ? { ...current, historyMaxTokens: next } : undefined;
			});
			continue;
		}
		if (selected.startsWith("Synthesis timeout:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await choosePositiveInteger(ctx, "Synthesis timeout in milliseconds", current.synthesisTimeoutMs);
				return next !== undefined ? { ...current, synthesisTimeoutMs: next } : undefined;
			});
			continue;
		}
		if (selected.startsWith("Continuation artifact:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await ctx.ui.select("Continuation artifact", ["always", "off"]);
				return next ? { ...current, continuationArtifactMode: next as ContinuationConfig["continuationArtifactMode"] } : undefined;
			});
			continue;
		}
		if (selected.startsWith("Agent guide path:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await ctx.ui.input("Agent guide path", "repo-relative path, default AGENTS.md");
				return next?.trim() ? { ...current, agentGuidePath: next.trim() } : undefined;
			});
			continue;
		}
		if (selected.startsWith("Agent guide updates:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await ctx.ui.select("Agent guide sync", ["off", "always"]);
				return next ? { ...current, agentGuideSyncMode: next as ContinuationConfig["agentGuideSyncMode"] } : undefined;
			});
			continue;
		}
		if (selected.startsWith("Automatic mid-run continuation:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => ({
				...current,
				midRunGuardEnabled: !current.midRunGuardEnabled,
			}));
			continue;
		}
		if (selected.startsWith("Adopt native threshold compaction:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => ({
				...current,
				adoptNativeCompaction: !current.adoptNativeCompaction,
			}));
			continue;
		}
		if (selected.startsWith("Compaction threshold mode:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await chooseCompactionThresholdMode(ctx);
				return next ? { ...current, compactionThresholdMode: next } : undefined;
			});
			continue;
		}
		if (selected.startsWith("Handoff trigger:")) {
			if (config.compactionThresholdMode === "percentage") {
				const previous = config;
				config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
					const next = await chooseCompactionThresholdPercent(ctx, current.compactionThresholdPercent);
					return next !== undefined ? { ...current, compactionThresholdPercent: next } : undefined;
				});
				if (config !== previous) ctx.ui.notify(`Updated ${scope} handoff trigger`, "info");
			} else {
				await updateHandoffTriggerFromDialog(ctx, scope, projectContext.projectRoot);
			}
			continue;
		}
		if (selected.startsWith("Append compaction metadata:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => ({
				...current,
				appendCompactionMetadata: !current.appendCompactionMetadata,
			}));
			continue;
		}
		if (selected.startsWith("Append read file tags:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => ({
				...current,
				appendReadFileTags: !current.appendReadFileTags,
			}));
			continue;
		}
		if (selected.startsWith("Append modified file tags:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => ({
				...current,
				appendModifiedFileTags: !current.appendModifiedFileTags,
			}));
			continue;
		}
		if (selected.startsWith("Prompt override policy:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => {
				const next = await ctx.ui.select("Prompt override policy", ["package-default", "global-override", "project-override"]);
				return next ? { ...current, promptOverridePolicy: next as ContinuationConfig["promptOverridePolicy"] } : undefined;
			});
			continue;
		}
		if (selected.startsWith("Show brief after compaction:")) {
			config = await updateSetting(scope, projectContext.projectRoot, config, async (current) => ({
				...current,
				showAfterCompact: !current.showAfterCompact,
			}));
			continue;
		}
		if (selected === `Reset ${scope} settings`) {
			const confirmed = await ctx.ui.confirm(`Reset ${scope} settings?`, `Delete the ${scope} settings file and fall back to global/default settings?`);
			if (confirmed) {
				await resetContinuationConfig(scope, projectContext.projectRoot);
				config = loadScopeConfig(scope, projectContext.projectRoot);
				ctx.ui.notify(`Reset ${scope} continuation settings`, "info");
			}
		}
	}
}

/** Show effective config and prompt provenance. */
export async function runStatusCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: ContinuationRuntimeState): Promise<void> {
	if (!(await requireUi(ctx))) return;
	const sessionId = ctx.sessionManager.getSessionId();
	const initialProjectContext = await resolveProjectContext(pi, ctx.cwd, sessionId);
	const config = loadContinuationConfig(initialProjectContext.projectRoot);
	const projectContext = await resolveProjectContext(pi, ctx.cwd, sessionId, config.agentGuidePath);
	const payload = await buildPromptPreviewPayload(pi, ctx, undefined);
	await showText(
		ctx,
		"continuation status",
		renderStatus(
			ctx,
			config,
			projectContext.projectRoot,
			projectContext.continuationArtifactPath,
			projectContext.agentGuidePath,
			payload,
			getLatestContinuationEvent(runtime),
		),
	);
}

/** Show the latest in-memory Continuation Ledger without mutating the transcript. */
export async function runLedgerCommand(ctx: ExtensionCommandContext, runtime: ContinuationRuntimeState, ledgerOverlay: ContinuationLedgerOverlayController): Promise<void> {
	await showLatestContinuationLedger(ctx, getLatestContinuationLedger(runtime), ledgerOverlay);
}

/** Reset scoped config. */
export async function runResetCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string | undefined): Promise<void> {
	if (!(await requireUi(ctx))) return;
	const projectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId());
	const parsedScope = parseScope(args, "reset");
	if (parsedScope.error) {
		ctx.ui.notify(parsedScope.error, "warning");
		return;
	}
	const scope = parsedScope.scope;
	const confirmed = await ctx.ui.confirm(`Reset ${scope} settings?`, `Delete the ${scope} settings file and fall back to global/default settings?`);
	if (!confirmed) return;
	await resetContinuationConfig(scope, projectContext.projectRoot);
	ctx.ui.notify(`Reset ${scope} continuation settings`, "info");
}

/** Preview handoff prompts. */
export async function runPreviewCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string | undefined): Promise<void> {
	if (!(await requireUi(ctx))) return;
	const payload = await buildPromptPreviewPayload(pi, ctx, joinArgs(args));
	if (!payload) {
		ctx.ui.notify("No handoff preview is available.", "warning");
		return;
	}
	const section = renderPromptPreview(`Handoff prompt (${payload.scenario})`, payload.history);
	await showText(ctx, "handoff prompt preview", section);
}
