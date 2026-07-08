import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadHistoryPromptAssets } from "./src/assets.ts";
import { parseHistoryArtifacts } from "./src/blocks.ts";
import { splitContinueSubcommand, shouldOpenContinuePalette } from "./src/command-shape.ts";
import { runContinuePaletteResult, runEnabledContinuationCommand } from "./src/command-runner.ts";
import { runLedgerCommand, runPreviewCommand, runResetCommand, runSettingsDialog, runStatusCommand } from "./src/commands.ts";
import { getContinueArgumentCompletions } from "./src/completions.ts";
import { normalizeCompactionPreparation, snapshotFileOperations, stripCompactionPreparationMessages } from "./src/compaction-preparation.ts";
import { composeCompactionSummary } from "./src/compose.ts";
import { DEFAULT_CONTINUE_CONFIG, loadContinuationConfig } from "./src/config.ts";
import {
	abandonActiveContinuationEvent,
	failPendingOutputWritesForEvent,
	getActiveContinuationEventId,
	isActiveRunningContinuationEvent,
	markContinuationArtifact,
	planContinuationOutputWrites,
	recordContinuationSynthesisFailure,
	recordContinuationSynthesisTelemetry,
	recordOutputWriteResult,
} from "./src/continuation-event.ts";
import { buildContinuationDetails, buildContinuationSynthesisTelemetry, parseContinuationDetails } from "./src/details.ts";
import { SYNTHESIS_ABORT_MESSAGE } from "./src/synthesis-error.ts";
import { buildLedgerSnapshot, createContinuationLedgerOverlayController } from "./src/ledger-viewer.ts";
import { runMidRunGuard } from "./src/mid-run-guard.ts";
import { PromptPassError, runPromptPass } from "./src/model.ts";
import { loadPiInternals } from "./src/pi-internals.ts";
import { compileHistoryPrompt } from "./src/prompt.ts";
import { resolveProjectContext, writeNormalizedMarkdownFile } from "./src/project.ts";
import { isContinuationPromptUserMessage } from "./src/prompt-dispatch.ts";
import { showContinuePalette } from "./src/palette.ts";
import {
	CONTINUATION_PROMPT,
	armDeferredResumeStartTimeout,
	clearResumeStartTimeout,
	createContinuationRuntimeState,
	dispatchVerifiedContinuationResume,
	failContinuationCompactionProof,
	failRunningAwaitingContinuationResume,
	markAwaitingContinuationResumeStarted,
	settleAwaitingContinuationResumeFromAssistant,
	type ContinuationRuntimeState,
	verifyContinuationCompactionProof,
} from "./src/runtime.ts";
import {
	INVALID_COMPACTION_PROOF_FAILURE,
	NATIVE_COMPACTION_FALLBACK_FAILURE,
	clearPendingResumeDispatch,
} from "./src/resume-proof.ts";
import type { AgentGuideWriteStatus, ContinuationSynthesisFailure, ContinuationSynthesisTelemetry, ParsedHistoryArtifacts, PendingOutputWrite, WriteMode } from "./src/types.ts";
import {
	clearWorkingVisuals,
	settleWorkingVisuals,
	updateWorkingVisuals,
} from "./src/working-ui.ts";

function decideAgentGuideWriteStatus(writeMode: WriteMode, agentGuideMd: string | undefined): AgentGuideWriteStatus {
	if (writeMode === "off") return "write-off";
	return agentGuideMd ? "replacement-pending" : "no-replacement";
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}

const OUTPUT_WRITE_FAILURE = "Output write failed; check the configured path and permissions.";
const PENDING_OUTPUT_WRITE_FAILURE = "Output write did not complete before continuation failed.";

class ArtifactParseError extends Error {
	readonly failure: ContinuationSynthesisFailure;

	constructor(failure: ContinuationSynthesisFailure) {
		super(failure.code);
		this.failure = failure;
	}
}

function normalizeSynthesisFailure(error: unknown): ContinuationSynthesisFailure {
	if (error instanceof PromptPassError) {
		return {
			kind: "model-provider-call",
			code: error.code,
			pass: "history",
			requestedModel: error.requestedModel,
			httpStatus: error.httpStatus,
		};
	}
	if (error instanceof ArtifactParseError) return error.failure;
	return { kind: "internal", code: "internal-error", pass: "history" };
}

export default function (pi: ExtensionAPI) {
	const pendingOutputWrites = new Map<string, PendingOutputWrite>();
	const runtime = createContinuationRuntimeState();
	const ledgerOverlay = createContinuationLedgerOverlayController();

	function cleanupPendingOutputWrites(eventId: string): void {
		let removed = false;
		for (const [writeId, pending] of pendingOutputWrites) {
			if (pending.eventId !== eventId) continue;
			pendingOutputWrites.delete(writeId);
			removed = true;
		}
		if (removed) {
			failPendingOutputWritesForEvent(runtime, eventId, PENDING_OUTPUT_WRITE_FAILURE);
		}
	}

	pi.registerCommand("continue", {
		description: "Save a same-session handoff, resume this run, or inspect continuation settings.",
		getArgumentCompletions: getContinueArgumentCompletions,
		handler: async (args, ctx) => {
			if (shouldOpenContinuePalette(args, ctx.hasUI)) {
				const palette = await showContinuePalette(pi, ctx, runtime);
				if (palette.supported) {
					if (palette.result) {
						await runContinuePaletteResult(pi, ctx, runtime, ledgerOverlay, palette.result, (eventId) => cleanupPendingOutputWrites(eventId));
					}
					return;
				}
			}
			const subcommand = splitContinueSubcommand(args);
			if (subcommand?.name === "status") {
				await runStatusCommand(pi, ctx, runtime);
				return;
			}
			if (subcommand?.name === "ledger") {
				await runLedgerCommand(ctx, runtime, ledgerOverlay);
				return;
			}
			if (subcommand?.name === "settings") {
				await runSettingsDialog(pi, ctx, subcommand.rest);
				return;
			}
			if (subcommand?.name === "reset") {
				await runResetCommand(pi, ctx, subcommand.rest);
				return;
			}
			if (subcommand?.name === "preview") {
				await runPreviewCommand(pi, ctx, subcommand.rest);
				return;
			}
			await runEnabledContinuationCommand(
				pi,
				ctx,
				runtime,
				args,
				(eventId) => cleanupPendingOutputWrites(eventId),
			);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.prompt !== CONTINUATION_PROMPT) return;
		const eventId = markAwaitingContinuationResumeStarted(runtime);
		if (!eventId) return;
		updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
	});

	pi.on("message_start", async (event, ctx) => {
		if (isContinuationPromptUserMessage(event.message, CONTINUATION_PROMPT)) {
			const eventId = markAwaitingContinuationResumeStarted(runtime);
			if (eventId) {
				updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
			}
			return;
		}
		if (!isAssistantMessage(event.message)) return;
		const eventId = runtime.awaitingResumeEventId;
		if (!eventId || runtime.latestEvent?.id !== eventId || runtime.latestEvent.resume.status !== "running") return;
		updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
	});

	pi.on("agent_end", async (_event, ctx) => {
		const settlement = failRunningAwaitingContinuationResume(runtime, "Continuation resume did not produce an assistant response.");
		if (settlement) {
			settleWorkingVisuals(ctx, runtime, settlement.eventId);
			return;
		}
		armDeferredResumeStartTimeout(ctx, runtime);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		const settlement = settleAwaitingContinuationResumeFromAssistant(runtime, event.message);
		if (!settlement) return;
		settleWorkingVisuals(ctx, runtime, settlement.eventId);
	});

	pi.on("context", async (event, ctx) => {
		await runMidRunGuard(pi, ctx, runtime, event.messages, (eventId) => cleanupPendingOutputWrites(eventId));
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const ownerEventId = getActiveContinuationEventId(runtime);
		if (ownerEventId === undefined) return undefined;
		const ownerStillActive = () => isActiveRunningContinuationEvent(runtime, ownerEventId);
		const ownerLostResult = () => ownerStillActive() ? undefined : { cancel: true as const };
		const projectContext = await resolveProjectContext(pi, ctx.cwd, sessionId);
		const ownerLostAfterProjectContext = ownerLostResult();
		if (ownerLostAfterProjectContext) return ownerLostAfterProjectContext;
		const config = loadContinuationConfig(projectContext.projectRoot);
		if (!config.enabled) return { cancel: true };
		const resolvedProjectContext = await resolveProjectContext(pi, ctx.cwd, sessionId, config.agentGuidePath);
		const ownerLostAfterResolvedContext = ownerLostResult();
		if (ownerLostAfterResolvedContext) return ownerLostAfterResolvedContext;
		const normalizedPreparation = normalizeCompactionPreparation(event.preparation, event.branchEntries);
		if (normalizedPreparation.repairedProviderUnsafeSuffix && ctx.hasUI) {
			ctx.ui.notify("pi-continue summarized a provider-unsafe kept suffix before resuming.", "warning");
		} else if (normalizedPreparation.repairedNoOpCut && ctx.hasUI) {
			ctx.ui.notify("pi-continue moved the handoff to a safer checkpoint before resuming.", "warning");
		}
		// Strip pi-continue's own receiver prompt so the synthesizer never mistakes
		// our resume wrapper ("Continue from the same-session pi-continue/v4 handoff…")
		// for user content. Otherwise the synthesizer can promote our wrapper sentences
		// as `forbid` or `task` entries.
		const preparation = stripCompactionPreparationMessages(normalizedPreparation, (message) =>
			isContinuationPromptUserMessage(message, CONTINUATION_PROMPT)
		);
		const fileOpsSnapshot = snapshotFileOperations(preparation.fileOps);
		const internals = await loadPiInternals();
		const ownerLostAfterInternals = ownerLostResult();
		if (ownerLostAfterInternals) return ownerLostAfterInternals;
		const messagesToSummarize = preparation.messagesToSummarize;
		const turnPrefixMessages = preparation.turnPrefixMessages;
		const turnPrefixTranscript = preparation.isSplitTurn && turnPrefixMessages.length > 0
			? internals.serializeConversation(internals.convertToLlm(turnPrefixMessages))
			: undefined;
		const historyPrompt = compileHistoryPrompt(
			loadHistoryPromptAssets(
				resolvedProjectContext.projectRoot,
				config.promptOverridePolicy,
				preparation.previousSummary ? "update" : "initial",
			),
			{
				scenario: preparation.previousSummary ? "update" : "initial",
				projectRoot: resolvedProjectContext.projectRoot,
				agentGuidePath: resolvedProjectContext.agentGuidePath,
				existingAgentGuide: resolvedProjectContext.existingAgentGuide,
				previousSummary: preparation.previousSummary,
				historyTranscript: internals.serializeConversation(internals.convertToLlm(messagesToSummarize)),
				turnPrefixTranscript,
				customInstructions: event.customInstructions,
				fileOps: fileOpsSnapshot,
			},
		);
		let historyArtifacts: ParsedHistoryArtifacts;
		let synthesis: ContinuationSynthesisTelemetry | undefined;
		try {
			const historyOutput = await runPromptPass(pi, ctx, config, historyPrompt, preparation.settings.reserveTokens, event.signal);
			const ownerLostAfterSynthesis = ownerLostResult();
			if (ownerLostAfterSynthesis) return ownerLostAfterSynthesis;
			synthesis = buildContinuationSynthesisTelemetry(historyOutput);
			recordContinuationSynthesisTelemetry(runtime, ownerEventId, synthesis);
			const parsedHistoryArtifacts = parseHistoryArtifacts(historyOutput.text);
			if (!parsedHistoryArtifacts.ok) {
				throw new ArtifactParseError({
					kind: "artifact-parse-validation",
					code: parsedHistoryArtifacts.code,
					pass: "history",
					requestedModel: historyOutput.requestedModel,
					httpStatus: historyOutput.httpStatus,
				});
			}
			historyArtifacts = parsedHistoryArtifacts.artifacts;
			markContinuationArtifact(runtime, ownerEventId, "modeled", undefined);
		} catch (error) {
			if (ownerStillActive()) {
				recordContinuationSynthesisFailure(runtime, ownerEventId, normalizeSynthesisFailure(error));
				markContinuationArtifact(runtime, ownerEventId, "aborted", SYNTHESIS_ABORT_MESSAGE);
			}
			return { cancel: true };
		}
		const continuationArtifactWriteId = config.continuationArtifactMode === "always" ? randomUUID() : undefined;
		if (continuationArtifactWriteId) {
			pendingOutputWrites.set(continuationArtifactWriteId, {
				path: resolvedProjectContext.continuationArtifactPath,
				content: historyArtifacts.briefMarkdown,
				label: "continuation artifact",
				target: "continuation-artifact",
				eventId: ownerEventId,
			});
		}
		const agentGuideWriteStatus = decideAgentGuideWriteStatus(config.agentGuideSyncMode, historyArtifacts.agentGuideMd);
		const agentGuideWriteId = agentGuideWriteStatus === "replacement-pending" ? randomUUID() : undefined;
		if (agentGuideWriteId && historyArtifacts.agentGuideMd) {
			pendingOutputWrites.set(agentGuideWriteId, {
				path: resolvedProjectContext.agentGuidePath,
				content: historyArtifacts.agentGuideMd,
				label: "agent guide",
				target: "agent-guide",
				eventId: ownerEventId,
			});
		}
		planContinuationOutputWrites(
			runtime,
			ownerEventId,
			{
				continuationArtifact: continuationArtifactWriteId ? "pending" : "off",
				agentGuide: agentGuideWriteStatus === "replacement-pending"
					? "pending"
					: agentGuideWriteStatus === "no-replacement"
						? "no-replacement"
						: "off",
			},
		);
		const details = buildContinuationDetails(
			preparation.fileOps,
			continuationArtifactWriteId,
			agentGuideWriteId,
			agentGuideWriteStatus,
			historyArtifacts.agentGuideChangeReason,
			synthesis,
			ownerEventId,
		);
		return {
			compaction: {
				summary: composeCompactionSummary(historyArtifacts.briefMarkdown, details, {
					appendCompactionMetadata: config.appendCompactionMetadata,
					appendReadFileTags: config.appendReadFileTags,
					appendModifiedFileTags: config.appendModifiedFileTags,
				}),
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details,
			},
		};
	});

	pi.on("session_compact", async (event, ctx) => {
		const activeEventId = getActiveContinuationEventId(runtime);
		const activeCompactionProofVerified = activeEventId !== undefined
			&& runtime.latestEvent?.id === activeEventId
			&& runtime.latestEvent.compactionProof.status === "verified";
		if (activeEventId && !event.fromExtension) {
			if (!activeCompactionProofVerified) {
				failContinuationCompactionProof(ctx, runtime, activeEventId, NATIVE_COMPACTION_FALLBACK_FAILURE);
			}
			return;
		}
		if (!event.fromExtension) return;
		const details = parseContinuationDetails(event.compactionEntry.details);
		if (activeEventId && !details) {
			if (!activeCompactionProofVerified) {
				failContinuationCompactionProof(ctx, runtime, activeEventId, INVALID_COMPACTION_PROOF_FAILURE);
			}
			return;
		}
		if (!details) return;
		if (!details.continuationEventId) {
			if (activeEventId && !activeCompactionProofVerified) {
				failContinuationCompactionProof(ctx, runtime, activeEventId, INVALID_COMPACTION_PROOF_FAILURE);
			}
			return;
		}
		if (activeEventId && details.continuationEventId !== activeEventId) return;
		const acceptedActiveProof = activeEventId !== undefined && details.continuationEventId === activeEventId
			? verifyContinuationCompactionProof(ctx, runtime, activeEventId, event.compactionEntry.id)
			: false;
		const ledgerOwnerId = details.continuationEventId;
		const canUpdateLedger = isActiveRunningContinuationEvent(runtime, ledgerOwnerId);
		const ledger = canUpdateLedger
			? buildLedgerSnapshot(event.compactionEntry.summary, ledgerOwnerId, event.compactionEntry.id)
			: undefined;
		if (ledger) {
			runtime.latestLedger = ledger;
			const projectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId());
			const config = loadContinuationConfig(projectContext.projectRoot);
			if (config.enabled && config.showAfterCompact) {
				ledgerOverlay.showSoon(ctx, ledger, (reason) => {
					if (ctx.hasUI) ctx.ui.notify(`Could not open Continuation Ledger: ${reason}`, "error");
				});
			}
		}
		for (const writeId of [details.continuationArtifactWriteId, details.agentGuideWriteId]) {
			if (!writeId) continue;
			const pending = pendingOutputWrites.get(writeId);
			pendingOutputWrites.delete(writeId);
			if (!pending) continue;
			if (!isActiveRunningContinuationEvent(runtime, pending.eventId)) continue;
			try {
				const result = await writeNormalizedMarkdownFile(pending.path, pending.content);
				recordOutputWriteResult(runtime, pending.eventId, pending.target, result, undefined);
				if (ctx.hasUI) {
					ctx.ui.notify(
						result === "updated"
							? `Updated ${pending.label}.`
							: `${pending.label} was already up to date.`,
						"info",
					);
				}
			} catch {
				recordOutputWriteResult(runtime, pending.eventId, pending.target, "failed", OUTPUT_WRITE_FAILURE);
				if (ctx.hasUI) ctx.ui.notify(`Could not update ${pending.label}: ${OUTPUT_WRITE_FAILURE}`, "error");
			}
		}
		if (ctx.hasUI && details.agentGuideWriteStatus === "no-replacement" && details.agentGuideChangeReason) {
			ctx.ui.notify("Agent guide unchanged; no full replacement was produced.", "info");
		}
		if (acceptedActiveProof && activeEventId) {
			dispatchVerifiedContinuationResume(ctx, runtime, activeEventId);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		abandonActiveContinuationEvent(runtime, "Pi session shut down before continuation finished settling.");
		pendingOutputWrites.clear();
		clearWorkingVisuals(ctx, runtime);
		ledgerOverlay.clear();
		runtime.compactionRunning = false;
		runtime.guardFailureKey = undefined;
		runtime.lastNoCompactableGuardKey = undefined;
		clearResumeStartTimeout(runtime);
		clearPendingResumeDispatch(runtime);
		runtime.awaitingResumeEventId = undefined;
	});
}
