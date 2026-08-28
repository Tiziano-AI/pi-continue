import type {
	ContinuationArtifactStatus,
	ContinuationOutputWriteStatus,
	ContinuationOutputWriteTarget,
	ContinuationEventSource,
	ContinuationEventStore,
	ContinuationEventStatus,
	ContinuationLatestEvent,
	ContinuationPromptStatus,
	ContinuationResumeOutcome,
	ContinuationResumeStatus,
	ContinuationSynthesisFailure,
	ContinuationSynthesisTelemetry,
	ContinuationWriteStatus,
	MidRunGuardTrigger,
} from "./types.ts";

function nowMs(): number {
	return Date.now();
}

function nextEventId(store: ContinuationEventStore): string {
	store.nextEventSequence += 1;
	return `continue-${store.nextEventSequence}`;
}

function defaultOutputWrites(): ContinuationOutputWriteStatus {
	return {
		continuationArtifact: "off",
		agentGuide: "off",
	};
}

function defaultResume(): ContinuationResumeOutcome {
	return { status: "not-requested" };
}

function defaultCompactionProof() {
	return { status: "pending" as const };
}

function latestMatching(store: ContinuationEventStore, eventId: string | undefined): ContinuationLatestEvent | undefined {
	if (!eventId || !store.latestEvent || store.latestEvent.id !== eventId) return undefined;
	return store.latestEvent;
}

/** Return whether an event id still owns the latest continuation snapshot. */
export function isLatestContinuationEvent(store: ContinuationEventStore, eventId: string | undefined): boolean {
	return latestMatching(store, eventId) !== undefined;
}

/** Return whether a callback may still settle or advance the active running event. */
export function isActiveRunningContinuationEvent(store: ContinuationEventStore, eventId: string | undefined): boolean {
	const event = latestMatching(store, eventId);
	return event !== undefined && store.activeEventId === eventId && event.status === "running";
}

function activeLatest(store: ContinuationEventStore): ContinuationLatestEvent | undefined {
	return latestMatching(store, store.activeEventId);
}

function replaceLatest(store: ContinuationEventStore, next: ContinuationLatestEvent): void {
	store.latestEvent = next;
}

/** Start the single latest-event snapshot for a package-owned continuation run. */
export function beginContinuationEvent(
	store: ContinuationEventStore,
	source: ContinuationEventSource,
	trigger: MidRunGuardTrigger | undefined,
	promptStatus: ContinuationPromptStatus,
): ContinuationLatestEvent {
	const event: ContinuationLatestEvent = {
		id: nextEventId(store),
		source,
		status: "running",
		startedAt: nowMs(),
		trigger,
		artifactStatus: "pending",
		compactionProof: defaultCompactionProof(),
		promptStatus,
		outputWrites: defaultOutputWrites(),
		resume: defaultResume(),
	};
	store.latestEvent = event;
	store.activeEventId = event.id;
	return event;
}

/** Record a terminal blocked event without replacing an active running event. */
export function recordBlockedContinuationEvent(
	store: ContinuationEventStore,
	source: ContinuationEventSource,
	trigger: MidRunGuardTrigger | undefined,
	reason: string,
): ContinuationLatestEvent | undefined {
	if (store.activeEventId) return undefined;
	const timestamp = nowMs();
	const event: ContinuationLatestEvent = {
		id: nextEventId(store),
		source,
		status: "blocked",
		startedAt: timestamp,
		completedAt: timestamp,
		trigger,
		artifactStatus: "pending",
		compactionProof: { status: "failed", failureReason: reason },
		promptStatus: "not-requested",
		outputWrites: defaultOutputWrites(),
		resume: defaultResume(),
		failureReason: reason,
	};
	store.latestEvent = event;
	return event;
}

/** Return the currently active continuation event id for post-compaction side effects. */
export function getActiveContinuationEventId(store: ContinuationEventStore): string | undefined {
	return store.activeEventId;
}

/** Record whether the owned continuation produced a modeled ledger or aborted before a usable artifact. */
	export function markContinuationArtifact(
	store: ContinuationEventStore,
	eventId: string,
	status: ContinuationArtifactStatus,
	reason: string | undefined,
): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	replaceLatest(store, {
		...event,
		artifactStatus: status,
		failureReason: reason ?? event.failureReason,
	});
	return true;
}

/** 标记该 handoff 由机械摇树路径生成（无 LLM 摘要），恢复提示词相应使用简短版。 */
export function markContinuationShaken(store: ContinuationEventStore, eventId: string): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	replaceLatest(store, {
		...event,
		shaken: true,
	});
	return true;
}

/** Record whether the active continuation produced a modeled ledger or aborted before a usable artifact. */
export function markActiveContinuationArtifact(
	store: ContinuationEventStore,
	status: ContinuationArtifactStatus,
	reason: string | undefined,
): void {
	const eventId = store.activeEventId;
	if (!eventId) return;
	markContinuationArtifact(store, eventId, status, reason);
}

/** Record a bounded synthesis failure classifier without storing provider output. */
export function recordContinuationSynthesisFailure(
	store: ContinuationEventStore,
	eventId: string,
	failure: ContinuationSynthesisFailure,
): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	replaceLatest(store, {
		...event,
		synthesisFailure: failure,
	});
	return true;
}

/** Record a bounded synthesis failure classifier for the active continuation. */
export function recordActiveSynthesisFailure(store: ContinuationEventStore, failure: ContinuationSynthesisFailure): void {
	const eventId = store.activeEventId;
	if (!eventId) return;
	recordContinuationSynthesisFailure(store, eventId, failure);
}

/** Mark that Pi saved and reported the matching package-owned compaction entry. */
export function markContinuationCompactionProofVerified(store: ContinuationEventStore, eventId: string, compactionEntryId: string): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	replaceLatest(store, {
		...event,
		compactionProof: {
			status: "verified",
			compactionEntryId,
			verifiedAt: nowMs(),
		},
	});
	return true;
}

/** Mark that Pi did not report a valid package-owned compaction entry for the active continuation. */
export function markContinuationCompactionProofFailed(store: ContinuationEventStore, eventId: string, reason: string): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	replaceLatest(store, {
		...event,
		compactionProof: {
			status: "failed",
			failureReason: reason,
		},
		failureReason: reason,
	});
	return true;
}

/** Record summarizer telemetry for an owned continuation compaction. */
export function recordContinuationSynthesisTelemetry(
	store: ContinuationEventStore,
	eventId: string,
	synthesis: ContinuationSynthesisTelemetry | undefined,
): boolean {
	if (!synthesis) return false;
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	replaceLatest(store, {
		...event,
		synthesis,
	});
	return true;
}

/** Record summarizer telemetry for the active continuation compaction. */
export function recordActiveSynthesisTelemetry(
	store: ContinuationEventStore,
	synthesis: ContinuationSynthesisTelemetry | undefined,
): void {
	const eventId = store.activeEventId;
	if (!eventId) return;
	recordContinuationSynthesisTelemetry(store, eventId, synthesis);
}

/** Record planned output-write outcomes before Pi saves the compaction entry. */
export function planContinuationOutputWrites(
	store: ContinuationEventStore,
	eventId: string,
	outputWrites: ContinuationOutputWriteStatus,
): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	replaceLatest(store, {
		...event,
		outputWrites,
	});
	return true;
}

/** Record planned output-write outcomes before Pi saves the compaction entry for the active continuation. */
export function planActiveOutputWrites(
	store: ContinuationEventStore,
	outputWrites: ContinuationOutputWriteStatus,
): void {
	const eventId = store.activeEventId;
	if (!eventId) return;
	planContinuationOutputWrites(store, eventId, outputWrites);
}

function updateOutputTarget(
	current: ContinuationOutputWriteStatus,
	target: ContinuationOutputWriteTarget,
	status: ContinuationWriteStatus,
): ContinuationOutputWriteStatus {
	if (target === "continuation-artifact") return { ...current, continuationArtifact: status };
	return { ...current, agentGuide: status };
}

/** Apply a post-compaction output-write result only to the matching latest event id. */
export function recordOutputWriteResult(
	store: ContinuationEventStore,
	eventId: string,
	target: ContinuationOutputWriteTarget,
	status: ContinuationWriteStatus,
	reason: string | undefined,
): void {
	const event = latestMatching(store, eventId);
	if (!event) return;
	replaceLatest(store, {
		...event,
		outputWrites: updateOutputTarget(event.outputWrites, target, status),
		failureReason: status === "failed" && reason ? reason : event.failureReason,
	});
}

/** Mark that a same-session resume request is about to be dispatched. */
export function markContinuationResumePending(store: ContinuationEventStore, eventId: string): void {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return;
	if (event.resume.status !== "not-requested") return;
	replaceLatest(store, {
		...event,
		resume: { status: "pending" },
	});
}

/** Mark same-session continuation prompt dispatch after the prompt sender succeeds. */
export function markContinuationPromptSent(store: ContinuationEventStore, eventId: string): void {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return;
	replaceLatest(store, {
		...event,
		promptStatus: "sent",
		resume: event.resume.status === "not-requested" ? { status: "pending" } : event.resume,
	});
}

/** Mark the extension-owned resumed turn as started. */
export function markContinuationResumeStarted(store: ContinuationEventStore, eventId: string | undefined): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running" || event.resume.status !== "pending") return false;
	replaceLatest(store, {
		...event,
		resume: {
			...event.resume,
			status: "running",
			startedAt: nowMs(),
		},
	});
	return true;
}

function terminalPromptStatus(event: ContinuationLatestEvent, status: Extract<ContinuationEventStatus, "completed" | "failed">): ContinuationPromptStatus {
	if (status === "failed" && event.promptStatus === "pending") return "failed";
	return event.promptStatus;
}

function terminalCompactionProof(
	event: ContinuationLatestEvent,
	status: Extract<ContinuationEventStatus, "completed" | "failed">,
	reason: string | undefined,
): ContinuationLatestEvent["compactionProof"] {
	if (status === "failed" && event.compactionProof.status === "pending") {
		return { status: "failed", failureReason: reason };
	}
	return event.compactionProof;
}

function terminalResumeOutcome(
	event: ContinuationLatestEvent,
	status: Extract<ContinuationEventStatus, "completed" | "failed">,
	reason: string | undefined,
): ContinuationResumeOutcome {
	if (event.resume.status === "not-requested") return event.resume;
	if (event.resume.status === "completed" || event.resume.status === "failed" || event.resume.status === "aborted") return event.resume;
	if (status === "completed") return event.resume;
	return {
		...event.resume,
		status: "failed",
		completedAt: nowMs(),
		failureReason: reason ?? event.resume.failureReason,
	};
}

/** Settle a running latest-event snapshot with a terminal compaction or dispatch outcome. */
export function finishContinuationEvent(
	store: ContinuationEventStore,
	eventId: string,
	status: Extract<ContinuationEventStatus, "completed" | "failed">,
	reason: string | undefined,
): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	replaceLatest(store, {
		...event,
		status,
		completedAt: nowMs(),
		compactionProof: terminalCompactionProof(event, status, reason),
		promptStatus: terminalPromptStatus(event, status),
		resume: terminalResumeOutcome(event, status, reason),
		failureReason: reason ?? event.failureReason,
	});
	store.activeEventId = undefined;
	return true;
}

/** Settle the resumed assistant turn for the matching active continuation. */
export function settleContinuationResume(
	store: ContinuationEventStore,
	eventId: string | undefined,
	status: Exclude<ContinuationResumeStatus, "not-requested" | "pending" | "running">,
	options: {
		stopReason?: string;
		requestedModel?: string;
		responseModel?: string;
		failureReason?: string;
	},
): boolean {
	const event = latestMatching(store, eventId);
	if (!event || store.activeEventId !== eventId || event.status !== "running") return false;
	if (event.resume.status !== "pending" && event.resume.status !== "running") return false;
	const failureReason = options.failureReason;
	const terminalEventStatus: Extract<ContinuationEventStatus, "completed" | "failed"> = status === "completed" ? "completed" : "failed";
	replaceLatest(store, {
		...event,
		status: terminalEventStatus,
		completedAt: nowMs(),
		resume: {
			...event.resume,
			status,
			completedAt: nowMs(),
			stopReason: options.stopReason,
			requestedModel: options.requestedModel,
			responseModel: options.responseModel,
			failureReason,
		},
		failureReason: failureReason ?? event.failureReason,
	});
	store.activeEventId = undefined;
	return true;
}

function failPendingOutputWrites(outputWrites: ContinuationOutputWriteStatus): ContinuationOutputWriteStatus {
	return {
		continuationArtifact: outputWrites.continuationArtifact === "pending" ? "failed" : outputWrites.continuationArtifact,
		agentGuide: outputWrites.agentGuide === "pending" ? "failed" : outputWrites.agentGuide,
	};
}

/** Mark pending output-write outcomes for an event as failed without changing terminal compaction status. */
export function failPendingOutputWritesForEvent(store: ContinuationEventStore, eventId: string | undefined, reason: string): void {
	const event = latestMatching(store, eventId);
	if (!event) return;
	replaceLatest(store, {
		...event,
		outputWrites: failPendingOutputWrites(event.outputWrites),
		failureReason: reason,
	});
}

function abandonedResume(event: ContinuationLatestEvent, reason: string): ContinuationResumeOutcome {
	if (event.resume.status !== "pending" && event.resume.status !== "running") return event.resume;
	return {
		...event.resume,
		status: "failed",
		completedAt: event.resume.completedAt ?? nowMs(),
		failureReason: reason,
	};
}

/** Settle active or pending latest-event state when shutdown abandons continuation side effects. */
export function abandonActiveContinuationEvent(store: ContinuationEventStore, reason: string): void {
	const event = activeLatest(store) ?? store.latestEvent;
	if (!event) return;
	const hasPendingWrites = event.outputWrites.continuationArtifact === "pending" || event.outputWrites.agentGuide === "pending";
	const activeOrRunning = store.activeEventId === event.id || event.status === "running";
	if (!activeOrRunning && !hasPendingWrites) return;
	replaceLatest(store, {
		...event,
		status: activeOrRunning ? "failed" : event.status,
		completedAt: event.completedAt ?? nowMs(),
		promptStatus: activeOrRunning && event.promptStatus === "pending" ? "failed" : event.promptStatus,
		outputWrites: failPendingOutputWrites(event.outputWrites),
		resume: abandonedResume(event, reason),
		failureReason: reason,
	});
	if (store.activeEventId === event.id) store.activeEventId = undefined;
}
