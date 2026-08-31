/**
 * Compaction planning built exclusively from Pi's public package API.
 *
 * pi-continue needs three things from Pi:
 *
 *   1. A context-token estimate for the running conversation (mid-run guard).
 *   2. The preparation Pi itself computes before a compaction (preflight for
 *      the guard and for `/continue preview`).
 *   3. A serialized transcript of the messages that will be summarized.
 *
 * Resolving Pi's internal `dist/` modules at runtime (via `import.meta.resolve`
 * plus dynamic imports of `dist/core/...` files) bypasses Pi's extension
 * loader, which supplies the `@earendil-works/*` peer packages through jiti
 * aliases (Node builds) or virtual modules (standalone binaries). Pi never
 * physically installs those peers into the agent npm tree, so that resolution
 * throws on every guard evaluation in managed installs ("Cannot find module
 * '@earendil-works/pi-coding-agent'", upstream issue #12) and surfaces as
 * `automatic continuation: handoff failed` on auto-compact (upstream issue #11).
 *
 * This module composes the same planning from Pi's public root exports only,
 * all stable since the 0.74.0 peer minimum:
 *
 *   - buildSessionContext / sessionEntryToContextMessages
 *   - estimateTokens / calculateContextTokens
 *   - findCutPoint
 *   - convertToLlm / serializeConversation
 *
 * Because the planning is composed from whichever Pi is installed, version
 * behavior (e.g. `findCutPoint` token accounting) is inherited from the
 * installed Pi instead of being pinned to one internal implementation.
 * `prepareCompaction` follows the 0.84.x shape: when nothing remains to
 * summarize it returns `undefined`, so the guard never starts a compaction
 * that Pi would reject as "Nothing to compact".
 */
import {
	buildSessionContext,
	calculateContextTokens,
	convertToLlm,
	estimateTokens,
	findCutPoint,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
} from "./compaction-preparation.ts";
import type { ContinuationCompactionPreparation } from "./compaction-preparation.ts";
import type { ContextUsageEstimateSnapshot, PiCompactionSettings } from "./types.ts";

/** The message element type of Pi's public `convertToLlm`/`estimateTokens` signatures. */
type PiMessage = Parameters<typeof convertToLlm>[0][number];

/** Pi's public `estimateTokens`, widened to the package's `unknown` message boundary. */
export function estimateMessageTokens(message: unknown): number {
	return estimateTokens(message as PiMessage);
}

/**
 * Port of Pi's internal `getAssistantUsage`: the last non-aborted, non-error
 * assistant response whose usage reports a positive context total.
 */
function assistantUsage(message: unknown): Usage | undefined {
	if (message === null || typeof message !== "object") return undefined;
	if (!("usage" in message)) return undefined;
	const candidate = message as Partial<AssistantMessage>;
	if (candidate.role !== "assistant") return undefined;
	if (candidate.stopReason === "aborted" || candidate.stopReason === "error") return undefined;
	const usage = candidate.usage;
	if (!usage) return undefined;
	return calculateContextTokens(usage) > 0 ? usage : undefined;
}

/**
 * Port of Pi's internal `estimateContextTokens` (identical across the
 * 0.74-0.84 releases): last assistant usage plus estimated tokens for the
 * trailing messages after it, or pure estimation when no usage is present.
 */
export function estimateContextTokens(messages: readonly unknown[]): ContextUsageEstimateSnapshot {
	let usage: Usage | undefined;
	let usageIndex: number | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = assistantUsage(messages[index]);
		if (candidate) {
			usage = candidate;
			usageIndex = index;
			break;
		}
	}
	if (!usage || usageIndex === undefined) {
		let estimated = 0;
		for (const message of messages) estimated += estimateMessageTokens(message);
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}
	const usageTokens = calculateContextTokens(usage);
	let trailingTokens = 0;
	for (let index = usageIndex + 1; index < messages.length; index++) {
		trailingTokens += estimateMessageTokens(messages[index]);
	}
	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageIndex,
	};
}

/** Port of Pi's internal `getMessageFromEntryForCompaction`. */
function messageFromEntryForCompaction(entry: SessionEntry): unknown | undefined {
	if (entry.type === "compaction") return undefined;
	return sessionEntryToContextMessages(entry)[0];
}

/**
 * Port of Pi's `prepareCompaction`, composed from public exports. Returns the
 * same preparation shape Pi puts on the `session_before_compact` event.
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: PiCompactionSettings,
): ContinuationCompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1]!.type === "compaction") {
		return undefined;
	}
	let prevCompactionIndex = -1;
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		if (pathEntries[index]!.type === "compaction") {
			prevCompactionIndex = index;
			break;
		}
	}
	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;
	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;
	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: unknown[] = [];
	for (let index = boundaryStart; index < historyEnd; index++) {
		const message = messageFromEntryForCompaction(pathEntries[index]!);
		if (message) messagesToSummarize.push(message);
	}
	const turnPrefixMessages: unknown[] = [];
	if (cutPoint.isSplitTurn) {
		for (let index = cutPoint.turnStartIndex; index < cutPoint.firstKeptEntryIndex; index++) {
			const message = messageFromEntryForCompaction(pathEntries[index]!);
			if (message) turnPrefixMessages.push(message);
		}
	}
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}
	const fileOps: FileOperations = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as { readFiles?: unknown; modifiedFiles?: unknown };
			if (Array.isArray(details.readFiles)) {
				for (const file of details.readFiles) {
					if (typeof file === "string") fileOps.read.add(file);
				}
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const file of details.modifiedFiles) {
					if (typeof file === "string") fileOps.edited.add(file);
				}
			}
		}
	}
	for (const message of messagesToSummarize) extractFileOpsFromMessage(message, fileOps);
	for (const message of turnPrefixMessages) extractFileOpsFromMessage(message, fileOps);
	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

/**
 * Render the messages a compaction will summarize into the transcript block
 * used by the handoff prompt and preview (Pi's `convertToLlm` +
 * `serializeConversation`, both public root exports).
 */
export function renderConversationTranscript(messages: readonly unknown[]): string {
	return serializeConversation(convertToLlm(messages as Parameters<typeof convertToLlm>[0]));
}
