import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Pi's thinking levels, plus the sentinel that follows Pi's current level. */
export type ContinuationReasoning = "inherit" | ModelThinkingLevel;

export type PromptOverridePolicy = "package-default" | "global-override" | "project-override";
export type WriteMode = "always" | "off";
export type ConfigScope = "global" | "project";
export type HistoryScenario = "initial" | "update";

export interface ContinuationConfig {
	enabled: boolean;
	summarizerModel: string;
	reasoning: ContinuationReasoning;
	historyMaxTokens: number | null;
	synthesisTimeoutMs: number;
	continuationArtifactMode: WriteMode;
	agentGuidePath: string;
	agentGuideSyncMode: WriteMode;
	midRunGuardEnabled: boolean;
	adoptNativeCompaction: boolean;
	appendCompactionMetadata: boolean;
	appendReadFileTags: boolean;
	appendModifiedFileTags: boolean;
	promptOverridePolicy: PromptOverridePolicy;
	showAfterCompact: boolean;
}

export interface ResolvedProjectContext {
	projectRoot: string;
	continuationArtifactPath: string;
	agentGuidePath: string;
	existingAgentGuide: string | undefined;
}

export interface LoadedPromptAsset {
	content: string;
	sourcePath: string;
}

export interface HistoryPromptAssets {
	system: LoadedPromptAsset;
	baseUser: LoadedPromptAsset;
	scenarioUser: LoadedPromptAsset;
}

export interface FileOpsSnapshot {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface HistoryPromptInput {
	scenario: HistoryScenario;
	projectRoot: string;
	agentGuidePath: string;
	existingAgentGuide: string | undefined;
	previousSummary: string | undefined;
	historyTranscript: string;
	turnPrefixTranscript: string | undefined;
	customInstructions: string | undefined;
	fileOps: FileOpsSnapshot;
}

export interface CompiledPrompt {
	systemPrompt: string;
	userPrompt: string;
	sources: {
		system: string;
		baseUser?: string;
		scenarioUser: string;
	};
}

export interface ParsedHistoryArtifacts {
	briefMarkdown: string;
	agentGuideMd: string | undefined;
	agentGuideChangeReason: string;
}

export type ContinuationEventSource = "command-steer" | "command-queue" | "mid-run-guard" | "adopted-compaction";
export type ContinuationEventStatus = "running" | "completed" | "failed" | "blocked";
export type ContinuationArtifactStatus = "pending" | "modeled" | "aborted";
export type ContinuationPromptStatus = "pending" | "sent" | "not-requested" | "failed";
export type ContinuationResumeStatus = "not-requested" | "pending" | "running" | "completed" | "failed" | "aborted";
export type ContinuationCompactionProofStatus = "pending" | "verified" | "failed";
export type ContinuationSynthesisFailureKind = "model-provider-call" | "artifact-parse-validation" | "internal";
export type ContinuationSynthesisFailureCode =
	| "model-unresolved"
	| "auth-unavailable"
	| "provider-error"
	| "provider-aborted"
	| "provider-timeout"
	| "provider-truncated"
	| "artifact-empty"
	| "artifact-invalid-json"
	| "artifact-invalid-shape"
	| "artifact-ambiguous"
	| "internal-error";
export type ContinuationWriteStatus = "off" | "pending" | "updated" | "unchanged" | "failed" | "no-replacement";
export type ContinuationOutputWriteTarget = "continuation-artifact" | "agent-guide";

export interface HistoryOutputBudget {
	source: "pi-default" | "config";
	requestedTokens: number;
	effectiveTokens: number;
	modelMaxTokens?: number;
	clampedByModel: boolean;
}

export type HistoryArtifactParseFailureCode = "artifact-empty" | "artifact-invalid-json" | "artifact-invalid-shape" | "artifact-ambiguous";

export type HistoryArtifactParseResult =
	| { ok: true; artifacts: ParsedHistoryArtifacts }
	| { ok: false; code: HistoryArtifactParseFailureCode };

export interface PromptPassUsageTelemetry {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

export interface PromptPassTelemetry {
	requestedModel: string;
	responseModel?: string;
	responseId?: string;
	usage: PromptPassUsageTelemetry;
	httpStatus?: number;
	outputBudget?: HistoryOutputBudget;
}

export interface ContinuationSynthesisTelemetry {
	history?: PromptPassTelemetry;
	totalCost?: number;
	totalTokens?: number;
}

export interface ContinuationSynthesisFailure {
	kind: ContinuationSynthesisFailureKind;
	code: ContinuationSynthesisFailureCode;
	pass: "history";
	requestedModel?: string;
	httpStatus?: number;
}

export interface ContinuationCompactionProof {
	status: ContinuationCompactionProofStatus;
	compactionEntryId?: string;
	verifiedAt?: number;
	failureReason?: string;
}

export interface ContinuationResumeOutcome {
	status: ContinuationResumeStatus;
	startedAt?: number;
	completedAt?: number;
	stopReason?: string;
	requestedModel?: string;
	responseModel?: string;
	failureReason?: string;
}

export interface ContinuationOutputWriteStatus {
	continuationArtifact: ContinuationWriteStatus;
	agentGuide: ContinuationWriteStatus;
}

/** Latest operator-facing continuation lifecycle snapshot. It stores no transcript or document content. */
export interface ContinuationLatestEvent {
	id: string;
	source: ContinuationEventSource;
	status: ContinuationEventStatus;
	startedAt: number;
	completedAt?: number;
	trigger?: MidRunGuardTrigger;
	artifactStatus: ContinuationArtifactStatus;
	compactionProof: ContinuationCompactionProof;
	promptStatus: ContinuationPromptStatus;
	outputWrites: ContinuationOutputWriteStatus;
	resume: ContinuationResumeOutcome;
	synthesis?: ContinuationSynthesisTelemetry;
	synthesisFailure?: ContinuationSynthesisFailure;
	failureReason?: string;
}

export interface ContinuationEventStore {
	latestEvent: ContinuationLatestEvent | undefined;
	activeEventId: string | undefined;
	nextEventSequence: number;
}

/** Persisted status for whether a compaction attempted a configured agent-guide replacement. */
export type AgentGuideWriteStatus = "write-off" | "no-replacement" | "replacement-pending";

export type ContinuationCompactionDetailsKind = "pi-continue/v4";

/** Package-owned details saved on Pi compaction entries for lifecycle bookkeeping. */
export interface ContinuationCompactionDetails {
	kind: ContinuationCompactionDetailsKind;
	readFiles: string[];
	modifiedFiles: string[];
	continuationArtifactWriteId?: string;
	agentGuideWriteId?: string;
	agentGuideWriteStatus?: AgentGuideWriteStatus;
	agentGuideChangeReason?: string;
	continuationEventId?: string;
	synthesis?: ContinuationSynthesisTelemetry;
}

export interface ContinuationLedgerSnapshot {
	eventId: string | undefined;
	compactionEntryId: string;
	content: string;
	capturedAt: number;
}

export interface PendingOutputWrite {
	path: string;
	content: string;
	label: string;
	target: ContinuationOutputWriteTarget;
	eventId: string;
}

export interface PiCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface PreviewPayload {
	history: CompiledPrompt;
	scenario: HistoryScenario;
	isSplitTurn: boolean;
}

export interface ContextUsageEstimateSnapshot {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

/** One adoptable checkpoint opened by an assistant turn that ended on its own. */
export interface ContinuationAdoptionCheckpoint {
	stopReason: string | undefined;
	openedAt: number;
}

/**
 * Local record of how the session reached the current checkpoint.
 *
 * Pi's `session_before_compact` event does not say why Pi started compacting, so
 * adoption is gated on a single-use checkpoint opened when an assistant turn ends
 * and closed by new user input, a new turn, or the first compaction that claims it.
 */
export interface ContinuationTurnProvenance {
	adoptionCheckpoint: ContinuationAdoptionCheckpoint | undefined;
	lastAssistantStopReason: string | undefined;
}

export interface MidRunGuardTrigger {
	estimatedTokens: number;
	thresholdTokens: number;
	contextWindow: number;
	reserveTokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}
