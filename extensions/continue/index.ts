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
import { buildContinuationDetails, buildContinuationSynthesisTelemetry, combinePromptPassAttempts, parseContinuationDetails } from "./src/details.ts";
import { describeSynthesisAbort } from "./src/synthesis-error.ts";
import { buildLedgerSnapshot, createContinuationLedgerOverlayController } from "./src/ledger-viewer.ts";
import { decideAdoptedCompactionTrigger, runMidRunGuard } from "./src/mid-run-guard.ts";
import { PromptPassError, runPromptPass } from "./src/model.ts";
import { loadPiInternals } from "./src/pi-internals.ts";
import { compileHistoryPrompt, withArtifactRepairReminder } from "./src/prompt.ts";
import { resolveProjectContext, writeNormalizedMarkdownFile } from "./src/project.ts";
import { isContinuationPromptUserMessage, sendContinuationPrompt } from "./src/prompt-dispatch.ts";
import { showContinuePalette } from "./src/palette.ts";
import {
	CONTINUATION_PROMPT,
	armDeferredResumeStartTimeout,
	clearResumeStartTimeout,
	createContinuationRuntimeState,
	dispatchVerifiedContinuationResume,
	failContinuationCompactionProof,
	clearContinuationAdoptionCheckpoint,
	consumeContinuationAdoptionCheckpoint,
	failRunningAwaitingContinuationResume,
	markAwaitingContinuationResumeStarted,
	markContinuationCompactionComplete,
	openContinuationAdoptionCheckpoint,
	recordAssistantStopReason,
	releaseAdoptedContinuationCompaction,
	settleAwaitingContinuationResumeFromAssistant,
	startAdoptedContinuationCompaction,
	type ContinuationRuntimeState,
	verifyContinuationCompactionProof,
} from "./src/runtime.ts";
import {
	INVALID_COMPACTION_PROOF_FAILURE,
	NATIVE_COMPACTION_FALLBACK_FAILURE,
	clearPendingResumeDispatch,
} from "./src/resume-proof.ts";
import type { AgentGuideWriteStatus, ContinuationSynthesisFailure, ContinuationSynthesisTelemetry, ParsedHistoryArtifacts, PendingOutputWrite, PromptPassTelemetry, WriteMode } from "./src/types.ts";
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
		// A new turn owns what happens next, so the previous checkpoint is no longer adoptable.
		clearContinuationAdoptionCheckpoint(runtime);
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

	pi.on("input", async (_event, _ctx) => {
		// New user input means the next compaction belongs to that submission, not to a
		// finished assistant turn, so it must not be adopted as an automatic checkpoint.
		clearContinuationAdoptionCheckpoint(runtime);
	});

	pi.on("agent_end", async (_event, ctx) => {
		openContinuationAdoptionCheckpoint(runtime);
		const settlement = failRunningAwaitingContinuationResume(runtime, "Continuation resume did not produce an assistant response.");
		if (settlement) {
			settleWorkingVisuals(ctx, runtime, settlement.eventId);
			return;
		}
		armDeferredResumeStartTimeout(ctx, runtime);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		recordAssistantStopReason(runtime, event.message.stopReason);
		const settlement = settleAwaitingContinuationResumeFromAssistant(runtime, event.message);
		if (!settlement) return;
		settleWorkingVisuals(ctx, runtime, settlement.eventId);
	});

	pi.on("context", async (event, ctx) => {
		await runMidRunGuard(pi, ctx, runtime, event.messages, (eventId) => cleanupPendingOutputWrites(eventId));
	});

	async function prepareCompactionHandoff(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
		ownership: { adoptedEventId?: string },
	) {
		const sessionId = ctx.sessionManager.getSessionId();
		const startedEventId = getActiveContinuationEventId(runtime);
		const projectContext = await resolveProjectContext(pi, ctx.cwd, sessionId);
		const config = loadContinuationConfig(projectContext.projectRoot);
		if (!config.enabled) return startedEventId === undefined ? undefined : { cancel: true };
		const normalizedPreparation = normalizeCompactionPreparation(event.preparation, event.branchEntries);
		// Pi runs its own compaction at the end of a turn, where the mid-run guard never
		// sees the context. Owning that over-threshold checkpoint keeps the ledger and the
		// same-session resume instead of silently falling back to Pi's summarizer.
		const adoptedTrigger = startedEventId === undefined
			? decideAdoptedCompactionTrigger({
				config,
				piCompactionEnabled: normalizedPreparation.settings.enabled,
				contextWindow: ctx.model?.contextWindow,
				reserveTokens: normalizedPreparation.settings.reserveTokens,
				tokensBefore: normalizedPreparation.tokensBefore,
				checkpoint: consumeContinuationAdoptionCheckpoint(runtime),
				reason: event.reason,
				now: Date.now(),
			})
			: undefined;
		const adoptedEventId = adoptedTrigger
			? startAdoptedContinuationCompaction(ctx, runtime, {
				trigger: adoptedTrigger,
				continueAfterComplete: true,
				sendContinuation: (prompt) => sendContinuationPrompt(pi, prompt),
				onContinuationFailed: (eventId) => cleanupPendingOutputWrites(eventId),
			})
			: undefined;
		const ownerEventId = startedEventId ?? adoptedEventId;
		if (ownerEventId === undefined) return undefined;
		const adopted = adoptedEventId !== undefined;
		if (adopted) ownership.adoptedEventId = adoptedEventId;
		const ownerStillActive = () => isActiveRunningContinuationEvent(runtime, ownerEventId);
		// A lost owner must never return package details. An owned handoff fails closed; an
		// adopted checkpoint is handed back to the compaction Pi decided to run.
		const ownerLostResult = () => ownerStillActive()
			? undefined
			: { stop: true as const, result: adopted ? undefined : { cancel: true as const } };
		const resolvedProjectContext = await resolveProjectContext(pi, ctx.cwd, sessionId, config.agentGuidePath);
		const ownerLostAfterResolvedContext = ownerLostResult();
		if (ownerLostAfterResolvedContext) return ownerLostAfterResolvedContext.result;
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
		if (ownerLostAfterInternals) return ownerLostAfterInternals.result;
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
			let attempt = await runPromptPass(pi, ctx, config, historyPrompt, preparation.settings.reserveTokens, event.signal);
			const ownerLostAfterSynthesis = ownerLostResult();
			if (ownerLostAfterSynthesis) return ownerLostAfterSynthesis.result;
			let passTelemetry: PromptPassTelemetry = attempt;
			synthesis = buildContinuationSynthesisTelemetry(passTelemetry);
			recordContinuationSynthesisTelemetry(runtime, ownerEventId, synthesis);
			let parsedHistoryArtifacts = parseHistoryArtifacts(attempt.text);
			if (!parsedHistoryArtifacts.ok) {
				// One bounded retry. Reminding the model of the artifact contract recovers
				// prose answers and mixed wrappers, and disabling reasoning for the retry
				// leaves the whole output budget for the artifact when the first attempt
				// spent it on reasoning tokens.
				attempt = await runPromptPass(
					pi,
					ctx,
					{ ...config, reasoning: "off" },
					withArtifactRepairReminder(historyPrompt),
					preparation.settings.reserveTokens,
					event.signal,
				);
				const ownerLostAfterRepair = ownerLostResult();
				if (ownerLostAfterRepair) return ownerLostAfterRepair.result;
				passTelemetry = combinePromptPassAttempts(passTelemetry, attempt);
				synthesis = buildContinuationSynthesisTelemetry(passTelemetry);
				recordContinuationSynthesisTelemetry(runtime, ownerEventId, synthesis);
				parsedHistoryArtifacts = parseHistoryArtifacts(attempt.text);
			}
			if (!parsedHistoryArtifacts.ok) {
				const truncated = attempt.stopReason === "length";
				throw new ArtifactParseError({
					kind: truncated ? "model-provider-call" : "artifact-parse-validation",
					code: truncated ? "provider-truncated" : parsedHistoryArtifacts.code,
					pass: "history",
					requestedModel: attempt.requestedModel,
					httpStatus: attempt.httpStatus,
				});
			}
			historyArtifacts = parsedHistoryArtifacts.artifacts;
			markContinuationArtifact(runtime, ownerEventId, "modeled", undefined);
		} catch (error) {
			if (ownerStillActive()) {
				const failure = normalizeSynthesisFailure(error);
				recordContinuationSynthesisFailure(runtime, ownerEventId, failure);
				markContinuationArtifact(runtime, ownerEventId, "aborted", describeSynthesisAbort(failure));
			}
			if (!adopted) return { cancel: true };
			releaseAdoptedContinuationCompaction(ctx, runtime, ownerEventId, (eventId) => cleanupPendingOutputWrites(eventId));
			return undefined;
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
		// Pi owns this compaction, so there is no package compact callback to report
		// completion. Arming the proof gate here keeps resume behind Pi's saved entry.
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

	let compactionHandoffInFlight = false;

	pi.on("session_before_compact", async (event, ctx) => {
		// One compaction at a time: a second operation entering while a handoff is being
		// prepared is cancelled rather than allowed to summarize and save the same branch in
		// parallel with it.
		if (compactionHandoffInFlight) return { cancel: true };
		// The package-owned request aborts the active run, and Pi reads that aborted turn as a
		// reason to start its own threshold or overflow compaction. Both operations would then
		// summarize the same branch, and whichever loses the save fails with "Already compacted".
		// The package-owned request arrives as `manual` and stays the single owner until it settles.
		if (runtime.compactionRunning && event.reason !== "manual") return { cancel: true };
		compactionHandoffInFlight = true;
		const ownership: { adoptedEventId?: string } = {};
		try {
			return await prepareCompactionHandoff(event, ctx, ownership);
		} catch (error) {
			// Pi swallows handler failures and continues with its own summarizer, so the event
			// this handler adopted is released instead of waiting for proof that never arrives.
			const adoptedEventId = ownership.adoptedEventId;
			if (adoptedEventId === undefined || !isActiveRunningContinuationEvent(runtime, adoptedEventId)) throw error;
			releaseAdoptedContinuationCompaction(ctx, runtime, adoptedEventId, (eventId) => cleanupPendingOutputWrites(eventId));
			return undefined;
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
		clearResumeStartTimeout(runtime);
		clearPendingResumeDispatch(runtime);
		runtime.awaitingResumeEventId = undefined;
	});
}
