import { snapshotFileOperations, type FileOperations } from "./compaction-preparation.ts";
import type {
	AgentGuideWriteStatus,
	ContinuationCompactionDetails,
	ContinuationSynthesisTelemetry,
	HistoryOutputBudget,
	PromptPassTelemetry,
	PromptPassUsageTelemetry,
} from "./types.ts";

interface PromptPassMetadata {
	requestedModel: string;
	responseModel?: string;
	httpStatus?: number;
	totalTokens: number;
	costTotal: number;
	outputBudget?: HistoryOutputBudget;
}

interface ContinuationSummaryMetadata {
	kind: "pi-continue/v4";
	readFileCount: number;
	modifiedFileCount: number;
	continuationArtifactWriteId?: string;
	agentGuideWriteId?: string;
	agentGuideWriteStatus?: AgentGuideWriteStatus;
	agentGuideChangeReason?: string;
	continuationEventId?: string;
	synthesis?: {
		history?: PromptPassMetadata;
		totalCost?: number;
		totalTokens?: number;
	};
}

const CONTINUATION_DETAILS_KIND_V4 = "pi-continue/v4";
const CONTINUATION_DETAILS_KEYS = new Set<string>([
	"kind",
	"readFiles",
	"modifiedFiles",
	"continuationArtifactWriteId",
	"agentGuideWriteId",
	"agentGuideWriteStatus",
	"agentGuideChangeReason",
	"continuationEventId",
	"synthesis",
]);
const SYNTHESIS_KEYS = new Set<string>(["history", "totalCost", "totalTokens"]);
const PROMPT_PASS_KEYS = new Set<string>(["requestedModel", "responseModel", "responseId", "usage", "httpStatus", "outputBudget"]);
const USAGE_KEYS = new Set<string>(["input", "output", "cacheRead", "cacheWrite", "totalTokens", "costTotal"]);
const OUTPUT_BUDGET_KEYS = new Set<string>(["source", "requestedTokens", "effectiveTokens", "modelMaxTokens", "clampedByModel"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function asAgentGuideWriteStatus(value: unknown): AgentGuideWriteStatus | undefined {
	if (value === "write-off" || value === "no-replacement" || value === "replacement-pending") return value;
	return undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function optionalTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function invalidOptionalString(value: unknown): boolean {
	return value !== undefined && optionalTrimmedString(value) === undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function invalidOptionalNumber(value: unknown): boolean {
	return value !== undefined && optionalNonNegativeNumber(value) === undefined;
}

function requiredNonNegativeNumber(value: unknown): number | undefined {
	return optionalNonNegativeNumber(value);
}

function parseUsageTelemetry(value: unknown): PromptPassUsageTelemetry | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, USAGE_KEYS)) return undefined;
	const input = requiredNonNegativeNumber(value.input);
	const output = requiredNonNegativeNumber(value.output);
	const cacheRead = requiredNonNegativeNumber(value.cacheRead);
	const cacheWrite = requiredNonNegativeNumber(value.cacheWrite);
	const totalTokens = requiredNonNegativeNumber(value.totalTokens);
	const costTotal = requiredNonNegativeNumber(value.costTotal);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || totalTokens === undefined || costTotal === undefined) {
		return undefined;
	}
	return { input, output, cacheRead, cacheWrite, totalTokens, costTotal };
}

function parseOutputBudget(value: unknown): HistoryOutputBudget | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, OUTPUT_BUDGET_KEYS)) return undefined;
	if (value.source !== "pi-default" && value.source !== "config") return undefined;
	const requestedTokens = requiredNonNegativeNumber(value.requestedTokens);
	const effectiveTokens = requiredNonNegativeNumber(value.effectiveTokens);
	const modelMaxTokens = value.modelMaxTokens === undefined ? undefined : requiredNonNegativeNumber(value.modelMaxTokens);
	if (requestedTokens === undefined || effectiveTokens === undefined || modelMaxTokens === undefined && value.modelMaxTokens !== undefined) return undefined;
	if (typeof value.clampedByModel !== "boolean") return undefined;
	return {
		source: value.source,
		requestedTokens,
		effectiveTokens,
		modelMaxTokens,
		clampedByModel: value.clampedByModel,
	};
}

function parsePromptPassTelemetry(value: unknown): PromptPassTelemetry | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, PROMPT_PASS_KEYS)) return undefined;
	const requestedModel = optionalTrimmedString(value.requestedModel);
	const usage = parseUsageTelemetry(value.usage);
	if (!requestedModel || !usage) return undefined;
	if (invalidOptionalString(value.responseModel) || invalidOptionalString(value.responseId) || invalidOptionalNumber(value.httpStatus)) return undefined;
	const outputBudget = value.outputBudget === undefined ? undefined : parseOutputBudget(value.outputBudget);
	if (value.outputBudget !== undefined && !outputBudget) return undefined;
	const responseModel = optionalTrimmedString(value.responseModel);
	const responseId = optionalTrimmedString(value.responseId);
	const httpStatus = optionalNonNegativeNumber(value.httpStatus);
	return {
		requestedModel,
		responseModel,
		responseId,
		usage,
		httpStatus,
		outputBudget,
	};
}

function parseSynthesisTelemetry(value: unknown): ContinuationSynthesisTelemetry | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, SYNTHESIS_KEYS)) return undefined;
	if (invalidOptionalNumber(value.totalCost) || invalidOptionalNumber(value.totalTokens)) return undefined;
	const history = value.history === undefined ? undefined : parsePromptPassTelemetry(value.history);
	if (value.history !== undefined && !history) return undefined;
	const totalCost = optionalNonNegativeNumber(value.totalCost);
	const totalTokens = optionalNonNegativeNumber(value.totalTokens);
	if (!history && totalCost === undefined && totalTokens === undefined) return undefined;
	return {
		history,
		totalCost,
		totalTokens,
	};
}

function computeSynthesisTotals(history: PromptPassTelemetry | undefined): { totalCost: number | undefined; totalTokens: number | undefined } {
	return {
		totalCost: history ? history.usage.costTotal : undefined,
		totalTokens: history ? history.usage.totalTokens : undefined,
	};
}

function cloneOutputBudget(outputBudget: HistoryOutputBudget | undefined): HistoryOutputBudget | undefined {
	if (!outputBudget) return undefined;
	return { ...outputBudget };
}

function clonePromptPassTelemetry(telemetry: PromptPassTelemetry | undefined): PromptPassTelemetry | undefined {
	if (!telemetry) return undefined;
	return {
		requestedModel: telemetry.requestedModel,
		responseModel: telemetry.responseModel,
		responseId: telemetry.responseId,
		usage: {
			input: telemetry.usage.input,
			output: telemetry.usage.output,
			cacheRead: telemetry.usage.cacheRead,
			cacheWrite: telemetry.usage.cacheWrite,
			totalTokens: telemetry.usage.totalTokens,
			costTotal: telemetry.usage.costTotal,
		},
		httpStatus: telemetry.httpStatus,
		outputBudget: cloneOutputBudget(telemetry.outputBudget),
	};
}

/** Fold an extra synthesis attempt into the reported pass usage so retries are not under-reported. */
export function combinePromptPassAttempts(
	previous: PromptPassTelemetry | undefined,
	latest: PromptPassTelemetry,
): PromptPassTelemetry {
	if (!previous) return latest;
	return {
		...latest,
		usage: {
			input: previous.usage.input + latest.usage.input,
			output: previous.usage.output + latest.usage.output,
			cacheRead: previous.usage.cacheRead + latest.usage.cacheRead,
			cacheWrite: previous.usage.cacheWrite + latest.usage.cacheWrite,
			totalTokens: previous.usage.totalTokens + latest.usage.totalTokens,
			costTotal: previous.usage.costTotal + latest.usage.costTotal,
		},
	};
}

export function buildContinuationSynthesisTelemetry(
	history: PromptPassTelemetry | undefined,
): ContinuationSynthesisTelemetry | undefined {
	const historyTelemetry = clonePromptPassTelemetry(history);
	if (!historyTelemetry) return undefined;
	return {
		history: historyTelemetry,
		...computeSynthesisTotals(historyTelemetry),
	};
}

/** Parse the package-owned compaction-entry details payload used by session_compact. */
export function parseContinuationDetails(value: unknown): ContinuationCompactionDetails | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, CONTINUATION_DETAILS_KEYS)) return undefined;
	if (value.kind !== CONTINUATION_DETAILS_KIND_V4) return undefined;
	if (!isStringArray(value.readFiles) || !isStringArray(value.modifiedFiles)) return undefined;
	if (invalidOptionalString(value.continuationArtifactWriteId) || invalidOptionalString(value.agentGuideWriteId) || invalidOptionalString(value.agentGuideChangeReason) || invalidOptionalString(value.continuationEventId)) return undefined;
	if (value.agentGuideWriteStatus !== undefined && !asAgentGuideWriteStatus(value.agentGuideWriteStatus)) return undefined;
	const continuationArtifactWriteId = optionalTrimmedString(value.continuationArtifactWriteId);
	const agentGuideWriteId = optionalTrimmedString(value.agentGuideWriteId);
	const agentGuideWriteStatus = asAgentGuideWriteStatus(value.agentGuideWriteStatus);
	const agentGuideChangeReason = optionalTrimmedString(value.agentGuideChangeReason);
	const continuationEventId = optionalTrimmedString(value.continuationEventId);
	const synthesis = value.synthesis === undefined ? undefined : parseSynthesisTelemetry(value.synthesis);
	if (value.synthesis !== undefined && !synthesis) return undefined;
	const details: ContinuationCompactionDetails = {
		kind: CONTINUATION_DETAILS_KIND_V4,
		readFiles: value.readFiles,
		modifiedFiles: value.modifiedFiles,
	};
	if (continuationArtifactWriteId) details.continuationArtifactWriteId = continuationArtifactWriteId;
	if (agentGuideWriteId) details.agentGuideWriteId = agentGuideWriteId;
	if (agentGuideWriteStatus) details.agentGuideWriteStatus = agentGuideWriteStatus;
	if (agentGuideChangeReason) details.agentGuideChangeReason = agentGuideChangeReason;
	if (continuationEventId) details.continuationEventId = continuationEventId;
	if (synthesis) details.synthesis = synthesis;
	return details;
}

/** Build current-compaction details without inheriting cumulative path lists from older summaries. */
export function buildContinuationDetails(
	fileOps: FileOperations,
	continuationArtifactWriteId: string | undefined,
	agentGuideWriteId: string | undefined,
	agentGuideWriteStatus: AgentGuideWriteStatus | undefined,
	agentGuideChangeReason: string | undefined,
	synthesis: ContinuationSynthesisTelemetry | undefined,
	continuationEventId: string,
): ContinuationCompactionDetails {
	const { readFiles, modifiedFiles } = snapshotFileOperations(fileOps);
	const details: ContinuationCompactionDetails = {
		kind: CONTINUATION_DETAILS_KIND_V4,
		readFiles,
		modifiedFiles,
		continuationEventId,
	};
	if (continuationArtifactWriteId) details.continuationArtifactWriteId = continuationArtifactWriteId;
	if (agentGuideWriteId) details.agentGuideWriteId = agentGuideWriteId;
	if (agentGuideWriteStatus) details.agentGuideWriteStatus = agentGuideWriteStatus;
	if (agentGuideChangeReason) details.agentGuideChangeReason = agentGuideChangeReason;
	if (synthesis) details.synthesis = synthesis;
	return details;
}

function clip(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function escapeTaggedContent(content: string): string {
	return content
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderPromptPassMetadata(telemetry: PromptPassTelemetry | undefined): PromptPassMetadata | undefined {
	if (!telemetry) return undefined;
	return {
		requestedModel: telemetry.requestedModel,
		responseModel: telemetry.responseModel,
		httpStatus: telemetry.httpStatus,
		totalTokens: telemetry.usage.totalTokens,
		costTotal: telemetry.usage.costTotal,
		outputBudget: cloneOutputBudget(telemetry.outputBudget),
	};
}

function buildSummaryMetadata(details: ContinuationCompactionDetails): ContinuationSummaryMetadata {
	const metadata: ContinuationSummaryMetadata = {
		kind: CONTINUATION_DETAILS_KIND_V4,
		readFileCount: details.readFiles.length,
		modifiedFileCount: details.modifiedFiles.length,
	};
	if (details.continuationArtifactWriteId) metadata.continuationArtifactWriteId = details.continuationArtifactWriteId;
	if (details.agentGuideWriteId) metadata.agentGuideWriteId = details.agentGuideWriteId;
	if (details.agentGuideWriteStatus) metadata.agentGuideWriteStatus = details.agentGuideWriteStatus;
	if (details.agentGuideChangeReason) metadata.agentGuideChangeReason = clip(details.agentGuideChangeReason, 360);
	if (details.continuationEventId) metadata.continuationEventId = details.continuationEventId;
	if (details.synthesis) {
		metadata.synthesis = {
			history: renderPromptPassMetadata(details.synthesis.history),
			totalCost: details.synthesis.totalCost,
			totalTokens: details.synthesis.totalTokens,
		};
	}
	return metadata;
}

/** Serialize compact, non-path metadata for the visible compaction summary appendix. */
export function renderContinuationDetails(details: ContinuationCompactionDetails): string {
	const payload = escapeTaggedContent(JSON.stringify(buildSummaryMetadata(details), null, 2));
	return `<continuation-compaction-details>\n${payload}\n</continuation-compaction-details>`;
}
