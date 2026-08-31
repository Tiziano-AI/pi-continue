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
	markContinuationShaken,
	planContinuationOutputWrites,
	recordContinuationSynthesisFailure,
	recordContinuationSynthesisTelemetry,
	recordOutputWriteResult,
} from "./src/continuation-event.ts";
import { buildContinuationDetails, buildContinuationSynthesisTelemetry, parseContinuationDetails } from "./src/details.ts";
import { SYNTHESIS_ABORT_MESSAGE } from "./src/synthesis-error.ts";
import { buildLedgerSnapshot, createContinuationLedgerOverlayController } from "./src/ledger-viewer.ts";
import { decideNativeCompactionAdoption, runMidRunGuard, runPercentageThresholdGuard } from "./src/mid-run-guard.ts";
import { PromptPassError, runPromptPass } from "./src/model.ts";
import { readEffectivePiCompactionSettings } from "./src/pi-settings.ts";
import { loadPiInternals } from "./src/pi-internals.ts";
import { compileHistoryPrompt } from "./src/prompt.ts";
import { resolveProjectContext, writeNormalizedMarkdownFile } from "./src/project.ts";
import { isContinuationPromptUserMessage } from "./src/prompt-dispatch.ts";
import { SHAKE_CONTINUATION_PROMPT } from "./src/continuation-prompt.ts";
import { planMechanicalShake } from "./src/shake.ts";
import { showContinuePalette } from "./src/palette.ts";
import { shouldDeferNativeThresholdCompaction } from "./src/threshold.ts";
import {
	CONTINUATION_PROMPT,
	armContinuationCompactionProofTimeout,
	armDeferredResumeStartTimeout,
	clearNativeCompactionAdoptionCheckpoint,
	clearResumeStartTimeout,
	consumeNativeCompactionAdoptionCheckpoint,
	createContinuationRuntimeState,
	completeContinuationCompactionFromHost,
	failContinuationCompactionProof,
	failRunningAwaitingContinuationResume,
	invalidateUnstartedContinuationResume,
	markAwaitingContinuationResumeStarted,
	markContinuationCompactionComplete,
	markContinuationCompactionRunMode,
	normalizeMidRunGuardAbortMessage,
	recordNativeCompactionAdoptionCheckpoint,
	releaseAdoptedNativeCompaction,
	releaseContinuationToNativeFallback,
	settleAwaitingContinuationResumeFromAssistant,
	startAdoptedNativeCompaction,
	type ContinuationRuntimeState,
	verifyContinuationCompactionProof,
} from "./src/runtime.ts";
import {
	INVALID_COMPACTION_PROOF_FAILURE,
	NATIVE_COMPACTION_FALLBACK_FAILURE,
	STALE_COMPACTION_PROOF_FAILURE,
	clearPendingResumeDispatch,
	observeCooperativeContinuationPrompt,
	observeCooperativeContinuationTurn,
	setContinuationResumeOwner,
} from "./src/resume-proof.ts";
import type { AgentGuideWriteStatus, ContinuationCompactionDetails, ContinuationConfig, ContinuationLedgerSnapshot, ContinuationSynthesisFailure, ContinuationSynthesisTelemetry, ParsedHistoryArtifacts, PendingOutputWrite, WriteMode } from "./src/types.ts";
import {
	clearWorkingVisuals,
	settleWorkingVisuals,
	updateWorkingVisuals,
} from "./src/working-ui.ts";
import { isGoalContinuationPrompt, WorkflowCoordination } from "./src/workflow-coordination.ts";

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

function isUserMessage(message: unknown): boolean {
	return typeof message === "object" && message !== null && Reflect.get(message, "role") === "user";
}

function isGoalContinuationUserMessage(message: unknown): boolean {
	try {
		return typeof message === "object"
			&& message !== null
			&& Reflect.get(message, "role") === "user"
			&& isGoalContinuationPrompt(JSON.stringify(message));
	} catch {
		return false;
	}
}

type OptionalExtensionEventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

function registerOptionalExtensionEvent(
	pi: ExtensionAPI,
	eventName: string,
	handler: OptionalExtensionEventHandler,
): void {
	// 低版本宿主没有该事件；通过结构化注册保留运行时兼容，而不是扩大最低版本类型契约。
	const register = pi.on.bind(pi) as unknown as (name: string, callback: OptionalExtensionEventHandler) => void;
	register(eventName, handler);
}

function compactionFailureReason(event: unknown): string {
	if (typeof event === "object" && event !== null) {
		const errorMessage = Reflect.get(event, "errorMessage");
		if (typeof errorMessage === "string" && errorMessage.trim().length > 0) return errorMessage;
		if (Reflect.get(event, "aborted") === true) return "Pi aborted the native continuation compaction.";
	}
	return "Pi failed the native continuation compaction.";
}

const OUTPUT_WRITE_FAILURE = "Output write failed; check the configured path and permissions.";
const PENDING_OUTPUT_WRITE_FAILURE = "Output write did not complete before continuation failed.";
const CONTINUATION_LIFECYCLE_CHANNEL = "pi-continue:handoff-lifecycle";

interface DeferredOutputWrite {
	writeId: string;
	pending: PendingOutputWrite;
}

type ContinuationLifecyclePhase = "controlled-abort" | "failed";

function emitContinuationLifecycle(pi: ExtensionAPI, phase: ContinuationLifecyclePhase, eventId: string): void {
	pi.events.emit(CONTINUATION_LIFECYCLE_CHANNEL, { phase, eventId });
}

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

/** 机械摇树路径：有收益且骨架在预算内时返回零 LLM 调用的压缩内容，否则回退摘要。 */
async function evaluateMechanicalShake(
	ctx: ExtensionContext,
	runtime: ContinuationRuntimeState,
	config: ContinuationConfig,
	event: NativeAwareSessionBeforeCompactEvent,
	sessionId: string,
	ownerEventId: string,
	adopted: boolean,
): Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: ContinuationCompactionDetails } } | undefined> {
	const contextWindow = ctx.model?.contextWindow;
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	let plan;
	try {
		plan = planMechanicalShake({
			config,
			entries: event.branchEntries,
			contextWindow,
			cwd: ctx.cwd,
			sessionId,
		});
	} catch {
		// offload 写入失败等异常整体回退 LLM 摘要路径。
		return undefined;
	}
	if (!plan.viable) return undefined;
	if (!isActiveRunningContinuationEvent(runtime, ownerEventId)) return undefined;
	markContinuationArtifact(runtime, ownerEventId, "modeled", undefined);
	markContinuationShaken(runtime, ownerEventId);
	const details = buildContinuationDetails(
		{ read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		undefined,
		undefined,
		"write-off",
		undefined,
		undefined,
		ownerEventId,
	);
	if (adopted) markContinuationCompactionComplete(ctx, runtime, ownerEventId);
	else armContinuationCompactionProofTimeout(ctx, runtime, ownerEventId);
	return {
		compaction: {
			summary: plan.summary,
			firstKeptEntryId: plan.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details,
		},
	};
}

export default function (pi: ExtensionAPI) {
	const pendingOutputWrites = new Map<string, PendingOutputWrite>();
	const deferredOutputWrites = new Map<string, PendingOutputWrite>();
	const runtime = createContinuationRuntimeState();
	const ledgerOverlay = createContinuationLedgerOverlayController();
	const workflowCoordination = new WorkflowCoordination(pi);

	function cleanupPendingOutputWrites(eventId: string): void {
		emitContinuationLifecycle(pi, "failed", eventId);
		let removed = false;
		for (const writes of [pendingOutputWrites, deferredOutputWrites]) {
			for (const [writeId, pending] of writes) {
				if (pending.eventId !== eventId) continue;
				writes.delete(writeId);
				removed = true;
			}
		}
		if (removed) {
			failPendingOutputWritesForEvent(runtime, eventId, PENDING_OUTPUT_WRITE_FAILURE);
		}
		workflowCoordination.releaseEvent(eventId);
	}

	function takePendingOutputWrites(details: ContinuationCompactionDetails): DeferredOutputWrite[] {
		const writes: DeferredOutputWrite[] = [];
		for (const writeId of [details.continuationArtifactWriteId, details.agentGuideWriteId]) {
			if (!writeId || deferredOutputWrites.has(writeId)) continue;
			const pending = pendingOutputWrites.get(writeId);
			pendingOutputWrites.delete(writeId);
			if (!pending || !isActiveRunningContinuationEvent(runtime, pending.eventId)) continue;
			deferredOutputWrites.set(writeId, pending);
			writes.push({ writeId, pending });
		}
		return writes;
	}

	function discardDeferredOutputWrites(writes: readonly DeferredOutputWrite[]): void {
		for (const deferred of writes) {
			if (deferredOutputWrites.get(deferred.writeId) === deferred.pending) {
				deferredOutputWrites.delete(deferred.writeId);
			}
		}
	}

	function canApplyPostCompactionEffects(eventId: string | undefined): boolean {
		if (!eventId) return true;
		const latest = runtime.latestEvent;
		return latest?.id === eventId && latest.status !== "failed";
	}

	async function applyPostCompactionEffects(
		ctx: ExtensionContext,
		details: ContinuationCompactionDetails,
		ledger: ContinuationLedgerSnapshot | undefined,
		writes: readonly DeferredOutputWrite[],
	): Promise<void> {
		if (!canApplyPostCompactionEffects(details.continuationEventId ?? writes[0]?.pending.eventId)) {
			discardDeferredOutputWrites(writes);
			return;
		}
		if (ledger) {
			try {
				const projectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId());
				const config = loadContinuationConfig(projectContext.projectRoot);
				if (config.enabled && config.showAfterCompact) {
					ledgerOverlay.showSoon(ctx, ledger, (reason) => {
						if (ctx.hasUI) ctx.ui.notify(`Could not open Continuation Ledger: ${reason}`, "error");
					});
				}
			} catch {
				// 宿主已经确认压缩结果；显示层失败不能重新打开压缩窗口或阻断恢复。
			}
		}
		for (const deferred of writes) {
			const pending = deferred.pending;
			if (!canApplyPostCompactionEffects(pending.eventId)
				|| deferredOutputWrites.get(deferred.writeId) !== pending) continue;
			try {
				const result = await writeNormalizedMarkdownFile(pending.path, pending.content);
				if (deferredOutputWrites.get(deferred.writeId) === pending) {
					recordOutputWriteResult(runtime, pending.eventId, pending.target, result, undefined);
					if (ctx.hasUI) {
						ctx.ui.notify(
							result === "updated"
								? `Updated ${pending.label}.`
								: `${pending.label} was already up to date.`,
							"info",
						);
					}
				}
			} catch {
				if (deferredOutputWrites.get(deferred.writeId) === pending) {
					recordOutputWriteResult(runtime, pending.eventId, pending.target, "failed", OUTPUT_WRITE_FAILURE);
					if (ctx.hasUI) ctx.ui.notify(`Could not update ${pending.label}: ${OUTPUT_WRITE_FAILURE}`, "error");
				}
			} finally {
				if (deferredOutputWrites.get(deferred.writeId) === pending) deferredOutputWrites.delete(deferred.writeId);
			}
		}
		if (ctx.hasUI && details.agentGuideWriteStatus === "no-replacement" && details.agentGuideChangeReason) {
			ctx.ui.notify("Agent guide unchanged; no full replacement was produced.", "info");
		}
	}

	function deferCooperativePostCompactionEffects(
		ctx: ExtensionContext,
		details: ContinuationCompactionDetails,
		ledger: ContinuationLedgerSnapshot | undefined,
		writes: readonly DeferredOutputWrite[],
	): void {
		const session = ctx.sessionManager;
		const generation = workflowCoordination.getGeneration();
		// 定时任务必须晚于 session_compact 处理器返回，才能越过 Pi 手动压缩控制器的占用窗口。
		setTimeout(() => {
			if (!workflowCoordination.isCurrent(session, generation)) {
				discardDeferredOutputWrites(writes);
				return;
			}
			void applyPostCompactionEffects(ctx, details, ledger, writes).catch(() => {
				discardDeferredOutputWrites(writes);
			});
		}, 0);
	}

	function observeGoalContinuationPrompt(text: string, ctx: ExtensionContext): boolean {
		if (!isGoalContinuationPrompt(text)) return false;
		const eventId = getActiveContinuationEventId(runtime);
		if (!eventId || workflowCoordination.isSelfOwner(eventId)) return false;
		if (
			runtime.awaitingResumeEventId === eventId
			&& runtime.awaitingResumeStart?.resumeOwner === "cooperative-workflow"
		) return true;
		if (!workflowCoordination.isGoalOwner(ctx, [text])) return false;
		if (!setContinuationResumeOwner(runtime, eventId, "cooperative-workflow")) return false;
		return observeCooperativeContinuationPrompt(ctx, runtime, eventId);
	}

	function invalidateSupersededContinuation(ctx: ExtensionContext): void {
		const eventId = invalidateUnstartedContinuationResume(ctx, runtime);
		if (eventId) workflowCoordination.releaseEvent(eventId);
	}

	function isPiContinueResumePrompt(text: string): boolean {
		return text === CONTINUATION_PROMPT || text === SHAKE_CONTINUATION_PROMPT;
	}

	function observeSameRunContinuation(ctx: ExtensionContext): void {
		const eventId = getActiveContinuationEventId(runtime);
		if (!eventId || !observeCooperativeContinuationTurn(ctx, runtime, eventId)) return;
		if (runtime.awaitingResumeEventId === eventId && runtime.latestEvent?.resume.status === "running") {
			updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		workflowCoordination.bindSession(ctx.sessionManager);
	});

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
		if (isPiContinueResumePrompt(event.prompt)) {
			const eventId = markAwaitingContinuationResumeStarted(runtime);
			if (eventId) updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
			return;
		}
		if (observeGoalContinuationPrompt(event.prompt, ctx)) {
			const eventId = markAwaitingContinuationResumeStarted(runtime);
			if (eventId) updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
			return;
		}
		invalidateSupersededContinuation(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (
			isContinuationPromptUserMessage(event.message, CONTINUATION_PROMPT)
			|| isContinuationPromptUserMessage(event.message, SHAKE_CONTINUATION_PROMPT)
		) {
			const eventId = markAwaitingContinuationResumeStarted(runtime);
			if (eventId) {
				updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
			}
			return;
		}
		if (isGoalContinuationUserMessage(event.message)) {
			const messageText = JSON.stringify(event.message);
			if (observeGoalContinuationPrompt(messageText, ctx)) {
				const eventId = markAwaitingContinuationResumeStarted(runtime);
				if (eventId) updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
				return;
			}
			if (isUserMessage(event.message)) invalidateSupersededContinuation(ctx);
			return;
		}
		if (isUserMessage(event.message)) {
			invalidateSupersededContinuation(ctx);
			return;
		}
		if (!isAssistantMessage(event.message)) return;
		observeSameRunContinuation(ctx);
		const eventId = runtime.awaitingResumeEventId;
		if (!eventId || runtime.latestEvent?.id !== eventId || runtime.latestEvent.resume.status !== "running") return;
		updateWorkingVisuals(ctx, runtime, eventId, "pi-continue resume running");
	});

	pi.on("input", async (event, ctx) => {
		observeGoalContinuationPrompt(event.text, ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const settlement = failRunningAwaitingContinuationResume(runtime, "Continuation resume did not produce an assistant response.");
		if (settlement) {
			workflowCoordination.releaseEvent(settlement.eventId);
			settleWorkingVisuals(ctx, runtime, settlement.eventId);
			return;
		}
		armDeferredResumeStartTimeout(ctx, runtime);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		observeSameRunContinuation(ctx);
		const message = normalizeMidRunGuardAbortMessage(runtime, event.message);
		if (message === event.message) {
			recordNativeCompactionAdoptionCheckpoint(runtime, message.stopReason);
		} else {
			// 中性 stop 只用于收束已被 handoff 接管的旧 turn，不能作为新的原生压缩采用检查点。
			clearNativeCompactionAdoptionCheckpoint(runtime);
			const eventId = getActiveContinuationEventId(runtime);
			if (eventId) emitContinuationLifecycle(pi, "controlled-abort", eventId);
		}
		const settlement = settleAwaitingContinuationResumeFromAssistant(runtime, message);
		if (settlement) {
			workflowCoordination.releaseEvent(settlement.eventId);
			settleWorkingVisuals(ctx, runtime, settlement.eventId);
		}
		if (message !== event.message) return { message };
	});

	pi.on("turn_end", async (_event, ctx) => {
		await runPercentageThresholdGuard(pi, ctx, runtime, (eventId) => cleanupPendingOutputWrites(eventId));
	});

	pi.on("agent_start", async () => {
		clearNativeCompactionAdoptionCheckpoint(runtime);
	});

	pi.on("context", async (event, ctx) => {
		observeSameRunContinuation(ctx);
		await runMidRunGuard(pi, ctx, runtime, event.messages, (eventId) => cleanupPendingOutputWrites(eventId));
	});

	let compactionHandoffInFlight = false;

	async function prepareContinuationCompaction(event: NativeAwareSessionBeforeCompactEvent, ctx: ExtensionContext) {
		const sessionId = ctx.sessionManager.getSessionId();
		const compactionValues: readonly unknown[] = [event.branchEntries, event.preparation];
		const goalWorkflowActive = workflowCoordination.isGoalOwner(ctx, compactionValues);
		const initialOwnerEventId = getActiveContinuationEventId(runtime);
		if (initialOwnerEventId !== undefined && runtime.latestEvent?.source === "adopted-compaction") {
			return { cancel: true as const };
		}
		const projectContext = await resolveProjectContext(pi, ctx.cwd, sessionId);
		const config = loadContinuationConfig(projectContext.projectRoot);
		const piSettings = initialOwnerEventId === undefined
			? readEffectivePiCompactionSettings(projectContext.projectRoot)
			: undefined;
		if (
			initialOwnerEventId === undefined
			&& event.reason === "threshold"
			&& event.willRetry !== true
			&& piSettings
			&& !goalWorkflowActive
			&& shouldDeferNativeThresholdCompaction(
				config,
				piSettings,
				ctx.model?.contextWindow,
				ctx.getContextUsage()?.tokens,
			)
		) {
			return { cancel: true as const };
		}
		if (initialOwnerEventId === undefined && (!config.enabled || !config.adoptNativeCompaction)) return undefined;
		if (initialOwnerEventId !== undefined && !config.enabled) {
			return goalWorkflowActive ? undefined : { cancel: true as const };
		}
		const internals = await loadPiInternals();
		let ownerEventId = initialOwnerEventId;
		let adopted = false;
		if (ownerEventId === undefined) {
			if (!piSettings) return undefined;
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
		const claimedOwner = workflowCoordination.claimEvent(ctx, ownerEventId, compactionValues);
		if (claimedOwner === "goal") {
			setContinuationResumeOwner(runtime, ownerEventId, "cooperative-workflow");
		}
		if (claimedOwner === "other") {
			if (adopted) {
				releaseAdoptedNativeCompaction(
					ctx,
					runtime,
					ownerEventId,
					"Another workflow owns the compaction boundary.",
					(eventId) => cleanupPendingOutputWrites(eventId),
				);
			} else {
				releaseContinuationToNativeFallback(
					ctx,
					runtime,
					ownerEventId,
					"Another workflow owns the compaction boundary.",
					(eventId) => cleanupPendingOutputWrites(eventId),
				);
			}
			return undefined;
		}
		const ownerStillActive = () => isActiveRunningContinuationEvent(runtime, ownerEventId);
		const delegatedToWorkflow = () => runtime.pendingResumeDispatch?.eventId === ownerEventId
			&& runtime.pendingResumeDispatch.resumeOwner === "cooperative-workflow";
		const ownerLostResult = () => adopted || delegatedToWorkflow() ? undefined : { cancel: true as const };
		if (!ownerStillActive()) return ownerLostResult();
		const resolvedProjectContext = await resolveProjectContext(pi, ctx.cwd, sessionId, config.agentGuidePath);
		if (!ownerStillActive()) return ownerLostResult();
		const normalizedPreparation = normalizeCompactionPreparation(event.preparation, event.branchEntries);
		if (normalizedPreparation.repairedProviderUnsafeSuffix && ctx.hasUI) {
			ctx.ui.notify("pi-continue adjusted the handoff boundary to preserve provider message ordering.", "info");
		} else if (normalizedPreparation.repairedNoOpCut && ctx.hasUI) {
			ctx.ui.notify("pi-continue moved the handoff to a usable checkpoint before resuming.", "info");
		}
		// 机械摇树优先：收益足够时零 LLM 调用完成 handoff，只有无收益或异常才回退摘要。
		if (config.shakeEnabled) {
			const shakePlan = await evaluateMechanicalShake(ctx, runtime, config, event, sessionId, ownerEventId, adopted);
			if (shakePlan) return shakePlan;
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
			if (delegatedToWorkflow()) {
				releaseContinuationToNativeFallback(
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
		else armContinuationCompactionProofTimeout(ctx, runtime, ownerEventId);
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
			const delegatedToWorkflow = activeEventId !== undefined
				&& runtime.pendingResumeDispatch?.eventId === activeEventId
				&& runtime.pendingResumeDispatch.resumeOwner === "cooperative-workflow";
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
			if (activeEventId && delegatedToWorkflow) {
				releaseContinuationToNativeFallback(
					ctx,
					runtime,
					activeEventId,
					SYNTHESIS_ABORT_MESSAGE,
					(eventId) => cleanupPendingOutputWrites(eventId),
				);
				return undefined;
			}
			if (activeEventId) workflowCoordination.releaseEvent(activeEventId);
			return activeEventId ? { cancel: true } : undefined;
		} finally {
			compactionHandoffInFlight = false;
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		const activeEventId = getActiveContinuationEventId(runtime);
		let branchEntries: readonly unknown[] = [];
		try {
			branchEntries = ctx.sessionManager.getBranch();
		} catch {
			branchEntries = [];
		}
		const goalWorkflowActive = (activeEventId !== undefined
			&& runtime.pendingResumeDispatch?.eventId === activeEventId
			&& runtime.pendingResumeDispatch.resumeOwner === "cooperative-workflow")
			|| workflowCoordination.isGoalOwner(ctx, [branchEntries, event.compactionEntry]);
		if (activeEventId && goalWorkflowActive) {
			setContinuationResumeOwner(runtime, activeEventId, "cooperative-workflow");
			markContinuationCompactionRunMode(runtime, activeEventId, !ctx.isIdle());
		}
		const activeCompactionProofVerified = activeEventId !== undefined
			&& runtime.latestEvent?.id === activeEventId
			&& runtime.latestEvent.compactionProof.status === "verified";
		if (activeEventId && !event.fromExtension) {
			if (!activeCompactionProofVerified) {
				if (goalWorkflowActive) {
					releaseContinuationToNativeFallback(
						ctx,
						runtime,
						activeEventId,
						NATIVE_COMPACTION_FALLBACK_FAILURE,
						(eventId) => cleanupPendingOutputWrites(eventId),
					);
				} else {
					failContinuationCompactionProof(ctx, runtime, activeEventId, NATIVE_COMPACTION_FALLBACK_FAILURE);
					workflowCoordination.releaseEvent(activeEventId);
				}
			}
			return;
		}
		if (!event.fromExtension) return;
		const details = parseContinuationDetails(event.compactionEntry.details);
		if (activeEventId && !details) {
			if (!activeCompactionProofVerified) {
				if (goalWorkflowActive) {
					releaseContinuationToNativeFallback(
						ctx,
						runtime,
						activeEventId,
						INVALID_COMPACTION_PROOF_FAILURE,
						(eventId) => cleanupPendingOutputWrites(eventId),
					);
				} else {
					failContinuationCompactionProof(ctx, runtime, activeEventId, INVALID_COMPACTION_PROOF_FAILURE);
					workflowCoordination.releaseEvent(activeEventId);
				}
			}
			return;
		}
		if (!details) return;
		if (!details.continuationEventId) {
			if (activeEventId && !activeCompactionProofVerified) {
				if (goalWorkflowActive) {
					releaseContinuationToNativeFallback(
						ctx,
						runtime,
						activeEventId,
						INVALID_COMPACTION_PROOF_FAILURE,
						(eventId) => cleanupPendingOutputWrites(eventId),
					);
				} else {
					failContinuationCompactionProof(ctx, runtime, activeEventId, INVALID_COMPACTION_PROOF_FAILURE);
					workflowCoordination.releaseEvent(activeEventId);
				}
			}
			return;
		}
		if (activeEventId && details.continuationEventId !== activeEventId) {
			if (goalWorkflowActive && !activeCompactionProofVerified) {
				releaseContinuationToNativeFallback(
					ctx,
					runtime,
					activeEventId,
					STALE_COMPACTION_PROOF_FAILURE,
					(eventId) => cleanupPendingOutputWrites(eventId),
				);
			}
			return;
		}
		const acceptedActiveProof = activeEventId !== undefined && details.continuationEventId === activeEventId
			? verifyContinuationCompactionProof(ctx, runtime, activeEventId, event.compactionEntry.id)
			: false;
		const ledgerOwnerId = details.continuationEventId;
		const canUpdateLedger = isActiveRunningContinuationEvent(runtime, ledgerOwnerId);
		const ledger = canUpdateLedger
			? buildLedgerSnapshot(event.compactionEntry.summary, ledgerOwnerId, event.compactionEntry.id)
			: undefined;
		if (ledger) runtime.latestLedger = ledger;
		const pendingWrites = takePendingOutputWrites(details);
		if (acceptedActiveProof && activeEventId && goalWorkflowActive) {
			if (completeContinuationCompactionFromHost(ctx, runtime, activeEventId)) {
				deferCooperativePostCompactionEffects(ctx, details, ledger, pendingWrites);
				return;
			}
		}
		await applyPostCompactionEffects(ctx, details, ledger, pendingWrites);
		if (acceptedActiveProof && activeEventId) {
			completeContinuationCompactionFromHost(ctx, runtime, activeEventId);
		}
	});

	registerOptionalExtensionEvent(pi, "session_compact_failed", (event, ctx) => {
		const activeEventId = getActiveContinuationEventId(runtime);
		if (!activeEventId || runtime.pendingResumeDispatch?.eventId !== activeEventId) return;
		runtime.controlledMidRunAbortRequested = false;
		let branchEntries: readonly unknown[] = [];
		try {
			branchEntries = ctx.sessionManager.getBranch();
		} catch {
			branchEntries = [];
		}
		const delegatedToWorkflow = runtime.pendingResumeDispatch?.eventId === activeEventId
			&& runtime.pendingResumeDispatch.resumeOwner === "cooperative-workflow";
		if (delegatedToWorkflow || workflowCoordination.isGoalOwner(ctx, [branchEntries, event])) {
			releaseContinuationToNativeFallback(
				ctx,
				runtime,
				activeEventId,
				compactionFailureReason(event),
				(eventId) => cleanupPendingOutputWrites(eventId),
			);
			return;
		}
		failContinuationCompactionProof(ctx, runtime, activeEventId, compactionFailureReason(event));
		workflowCoordination.releaseEvent(activeEventId);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		workflowCoordination.releaseAll();
		workflowCoordination.unbindSession(ctx.sessionManager);
		abandonActiveContinuationEvent(runtime, "Pi session shut down before continuation finished settling.");
		pendingOutputWrites.clear();
		deferredOutputWrites.clear();
		clearWorkingVisuals(ctx, runtime);
		ledgerOverlay.clear();
		runtime.compactionRunning = false;
		runtime.controlledMidRunAbortRequested = false;
		runtime.guardFailureKey = undefined;
		runtime.lastNoCompactableGuardKey = undefined;
		clearNativeCompactionAdoptionCheckpoint(runtime);
		clearResumeStartTimeout(runtime);
		clearPendingResumeDispatch(runtime);
		runtime.awaitingResumeEventId = undefined;
	});
}
