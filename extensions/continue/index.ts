import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { loadHistoryPromptAssets } from "./src/assets.ts";
import { parseHistoryArtifacts } from "./src/blocks.ts";
import { splitContinueSubcommand, shouldOpenContinuePalette } from "./src/command-shape.ts";
import { runContinuePaletteResult, runEnabledContinuationCommand } from "./src/command-runner.ts";
import { runLedgerCommand, runPreviewCommand, runResetCommand, runSettingsDialog, runStatusCommand } from "./src/commands.ts";
import { getContinueArgumentCompletions } from "./src/completions.ts";
import { normalizeCompactionPreparation, snapshotFileOperations, stripCompactionPreparationMessages } from "./src/compaction-preparation.ts";
import { composeCompactionSummary } from "./src/compose.ts";
import { DEFAULT_CONTINUE_CONFIG, loadContinuationConfig, withNativeAdoptionSynthesisTimeout } from "./src/config.ts";
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
import { decideNativeCompactionAdoption, runMidRunGuard } from "./src/mid-run-guard.ts";
import { PromptPassError, runPromptPass } from "./src/model.ts";
import { readEffectivePiCompactionSettings } from "./src/pi-settings.ts";
import { loadPiInternals } from "./src/pi-internals.ts";
import { compileHistoryPrompt } from "./src/prompt.ts";
import { resolveProjectContext, writeNormalizedMarkdownFile } from "./src/project.ts";
import { isContinuationPromptUserMessage } from "./src/prompt-dispatch.ts";
import { showContinuePalette } from "./src/palette.ts";
import {
	CONTINUATION_PROMPT,
	armDeferredResumeStartTimeout,
	clearNativeCompactionAdoptionCheckpoint,
	clearResumeStartTimeout,
	consumeNativeCompactionAdoptionCheckpoint,
	createContinuationRuntimeState,
	dispatchVerifiedContinuationResume,
	failContinuationCompactionProof,
	failRunningAwaitingContinuationResume,
	markAwaitingContinuationResumeStarted,
	markContinuationCompactionComplete,
	recordNativeCompactionAdoptionCheckpoint,
	releaseAdoptedNativeCompaction,
	settleAwaitingContinuationResumeFromAssistant,
	startAdoptedNativeCompaction,
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

type NativeAwareSessionBeforeCompactEvent = SessionBeforeCompactEvent & {
	reason?: string;
	willRetry?: boolean;
};

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
		recordNativeCompactionAdoptionCheckpoint(runtime, event.message.stopReason);
		const settlement = settleAwaitingContinuationResumeFromAssistant(runtime, event.message);
		if (!settlement) return;
		settleWorkingVisuals(ctx, runtime, settlement.eventId);
	});

	pi.on("agent_start", async () => {
		clearNativeCompactionAdoptionCheckpoint(runtime);
	});

	pi.on("context", async (event, ctx) => {
		await runMidRunGuard(pi, ctx, runtime, event.messages, (eventId) => cleanupPendingOutputWrites(eventId));
	});

	let compactionHandoffInFlight = false;

	async function prepareContinuationCompaction(event: NativeAwareSessionBeforeCompactEvent, ctx: ExtensionContext) {
		const sessionId = ctx.sessionManager.getSessionId();
		const initialOwnerEventId = getActiveContinuationEventId(runtime);
		if (initialOwnerEventId !== undefined && runtime.latestEvent?.source === "adopted-compaction") {
			return { cancel: true as const };
		}
		const projectContext = await resolveProjectContext(pi, ctx.cwd, sessionId);
		const config = loadContinuationConfig(projectContext.projectRoot);
		if (initialOwnerEventId === undefined && (!config.enabled || !config.adoptNativeCompaction)) return undefined;
		if (initialOwnerEventId !== undefined && !config.enabled) return { cancel: true as const };
		const internals = await loadPiInternals();
		let ownerEventId = initialOwnerEventId;
		let adopted = false;
		if (ownerEventId === undefined) {
			const piSettings = readEffectivePiCompactionSettings(projectContext.projectRoot);
			const shouldAdopt = decideNativeCompactionAdoption({
				config,
				checkpoint: runtime.nativeCompactionAdoptionCheckpoint,
				reason: event.reason,
				willRetry: event.willRetry,
				runActive: !ctx.isIdle(),
				hasPendingMessages: ctx.hasPendingMessages(),
				contextWindow: ctx.model?.contextWindow,
				preparation: event.preparation,
				branchEntries: event.branchEntries,
				piSettings,
				estimateTokens: (message) => internals.estimateTokens(
					message as Parameters<typeof internals.estimateTokens>[0],
				),
			});
			if (!shouldAdopt) return undefined;
			consumeNativeCompactionAdoptionCheckpoint(runtime);
			ownerEventId = startAdoptedNativeCompaction(ctx, runtime, {
				sendContinuation: (prompt) => pi.sendUserMessage(prompt, { deliverAs: "followUp" }),
				onContinuationFailed: (eventId) => cleanupPendingOutputWrites(eventId),
			});
			if (ownerEventId === undefined) return undefined;
			adopted = true;
		}
		const ownerStillActive = () => isActiveRunningContinuationEvent(runtime, ownerEventId);
		const ownerLostResult = () => adopted ? undefined : { cancel: true as const };
		if (!ownerStillActive()) return ownerLostResult();
		const resolvedProjectContext = await resolveProjectContext(pi, ctx.cwd, sessionId, config.agentGuidePath);
		if (!ownerStillActive()) return ownerLostResult();
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
		if (!ownerStillActive()) return ownerLostResult();
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
			const synthesisConfig = adopted ? withNativeAdoptionSynthesisTimeout(config) : config;
			const historyOutput = await runPromptPass(pi, ctx, synthesisConfig, historyPrompt, preparation.settings.reserveTokens, event.signal);
			if (!ownerStillActive()) return ownerLostResult();
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
			if (adopted) {
				releaseAdoptedNativeCompaction(
					ctx,
					runtime,
					ownerEventId,
					SYNTHESIS_ABORT_MESSAGE,
					(eventId) => cleanupPendingOutputWrites(eventId),
				);
				return undefined;
			}
			return { cancel: true as const };
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
		if (adopted) markContinuationCompactionComplete(ctx, runtime, ownerEventId);
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
	}

	pi.on("session_before_compact", async (event, ctx) => {
		if (compactionHandoffInFlight) return { cancel: true };
		compactionHandoffInFlight = true;
		try {
			return await prepareContinuationCompaction(event, ctx);
		} catch (error) {
			const activeEventId = getActiveContinuationEventId(runtime);
			if (activeEventId && runtime.latestEvent?.source === "adopted-compaction") {
				recordContinuationSynthesisFailure(runtime, activeEventId, normalizeSynthesisFailure(error));
				markContinuationArtifact(runtime, activeEventId, "aborted", SYNTHESIS_ABORT_MESSAGE);
				releaseAdoptedNativeCompaction(
					ctx,
					runtime,
					activeEventId,
					SYNTHESIS_ABORT_MESSAGE,
					(eventId) => cleanupPendingOutputWrites(eventId),
				);
				return undefined;
			}
			return activeEventId ? { cancel: true } : undefined;
		} finally {
			compactionHandoffInFlight = false;
		}
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
		clearNativeCompactionAdoptionCheckpoint(runtime);
		clearResumeStartTimeout(runtime);
		clearPendingResumeDispatch(runtime);
		runtime.awaitingResumeEventId = undefined;
	});
}
