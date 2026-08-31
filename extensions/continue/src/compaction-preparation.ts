import type { PiCompactionSettings } from "./types.ts";
import { assistantToolCallIds, messageRole as messageRoleOf, toolResultIdsMatchAssistant } from "./tool-batches.ts";

/** File-operation sets extracted from compacted assistant tool calls. */
export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/** Pi compaction preparation fields consumed by the continuation synthesizer. */
export interface ContinuationCompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: unknown[];
	turnPrefixMessages: unknown[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOperations;
	settings: PiCompactionSettings;
}

/** Continuation preparation after package-level safety repair decisions. */
export interface NormalizedCompactionPreparation extends ContinuationCompactionPreparation {
	repairedNoOpCut: boolean;
	repairedProviderUnsafeSuffix: boolean;
}

export const NO_PRE_COMPACTION_MESSAGES_KEPT_ENTRY_ID = "pi-continue-no-pre-compaction-messages-kept";

interface EntryRecord {
	type: string;
	id: string;
	message?: unknown;
	customType?: unknown;
	content?: unknown;
	display?: unknown;
	details?: unknown;
	timestamp?: unknown;
	summary?: unknown;
	fromId?: unknown;
	firstKeptEntryId?: unknown;
}

interface MessageRecord {
	role: string;
	content?: unknown;
}

interface ToolCallBlock {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asEntry(value: unknown): EntryRecord | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.type === "string" && typeof value.id === "string" ? { ...value, type: value.type, id: value.id } : undefined;
}

function asMessage(value: unknown): MessageRecord | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.role === "string" ? { ...value, role: value.role } : undefined;
}

function asToolCallBlock(value: unknown): ToolCallBlock | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type !== "toolCall" || typeof value.name !== "string" || !isRecord(value.arguments)) return undefined;
	return {
		type: "toolCall",
		name: value.name,
		arguments: value.arguments,
	};
}

function messageRole(entry: EntryRecord | undefined): string | undefined {
	return messageRoleOf(entry?.message);
}

export function createFileOps(): FileOperations {
	return {
		read: new Set<string>(),
		written: new Set<string>(),
		edited: new Set<string>(),
	};
}

export function snapshotFileOperations(fileOps: FileOperations): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set<string>([...fileOps.written, ...fileOps.edited]);
	const reads = new Set<string>(fileOps.read);
	for (const file of modified) reads.delete(file);
	return {
		readFiles: [...reads].sort((left, right) => left.localeCompare(right)),
		modifiedFiles: [...modified].sort((left, right) => left.localeCompare(right)),
	};
}

function messageFromEntryForCompaction(entry: EntryRecord): unknown | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			details: entry.details,
			timestamp: entry.timestamp,
		};
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string" && typeof entry.fromId === "string") {
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: entry.fromId,
			timestamp: entry.timestamp,
		};
	}
	return undefined;
}

function messagesFromEntryRange(entries: EntryRecord[], startIndex: number, endIndex: number): unknown[] {
	const messages: unknown[] = [];
	for (let index = startIndex; index < endIndex; index++) {
		const message = messageFromEntryForCompaction(entries[index]);
		if (message) messages.push(message);
	}
	return messages;
}

export function extractFileOpsFromMessage(message: unknown, fileOps: FileOperations): void {
	const record = asMessage(message);
	if (!record || record.role !== "assistant" || !Array.isArray(record.content)) return;
	for (const block of record.content) {
		const toolCall = asToolCallBlock(block);
		const path = typeof toolCall?.arguments.path === "string" ? toolCall.arguments.path : undefined;
		if (!toolCall || !path) continue;
		if (toolCall.name === "read") fileOps.read.add(path);
		if (toolCall.name === "write") fileOps.written.add(path);
		if (toolCall.name === "edit") fileOps.edited.add(path);
	}
}

function extractFileOps(messages: unknown[]): FileOperations {
	const fileOps = createFileOps();
	for (const message of messages) extractFileOpsFromMessage(message, fileOps);
	return fileOps;
}

function findCompletedToolResultSuffixAssistantIndex(entries: EntryRecord[]): number | undefined {
	let index = entries.length - 1;
	if (messageRole(entries[index]) !== "toolResult") return undefined;
	while (index >= 0 && messageRole(entries[index]) === "toolResult") index--;
	if (messageRole(entries[index]) !== "assistant") return undefined;
	return toolResultIdsMatchAssistant(
		entries.slice(index + 1).map((entry) => entry.message),
		entries[index].message,
	)
		? index
		: undefined;
}

function findPreviousCompactionIndex(entries: EntryRecord[], beforeIndex: number): number | undefined {
	for (let index = beforeIndex - 1; index >= 0; index--) {
		if (entries[index].type === "compaction") return index;
	}
	return undefined;
}

function findBoundaryStart(entries: EntryRecord[], beforeIndex: number): number {
	const compactionIndex = findPreviousCompactionIndex(entries, beforeIndex);
	if (compactionIndex === undefined) return 0;
	const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
	if (typeof firstKeptEntryId !== "string") return compactionIndex + 1;
	const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	return firstKeptIndex >= 0 ? firstKeptIndex : compactionIndex + 1;
}

function isTurnStart(entry: EntryRecord | undefined): boolean {
	if (!entry) return false;
	if (entry.type === "branch_summary" || entry.type === "custom_message") return true;
	const role = messageRole(entry);
	return role === "user" || role === "bashExecution";
}

function findTurnStartIndex(entries: EntryRecord[], entryIndex: number, startIndex: number): number | undefined {
	for (let index = entryIndex; index >= startIndex; index--) {
		if (isTurnStart(entries[index])) return index;
	}
	return undefined;
}

function shouldRepairNoOpPreparation(
	preparation: ContinuationCompactionPreparation,
	entries: EntryRecord[],
	assistantIndex: number,
): boolean {
	if (preparation.messagesToSummarize.length > 0 || preparation.turnPrefixMessages.length > 0) return false;
	const firstKeptIndex = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
	return firstKeptIndex >= 0 && firstKeptIndex < assistantIndex;
}

function cloneFileOps(fileOps: FileOperations): FileOperations {
	return {
		read: new Set(fileOps.read),
		written: new Set(fileOps.written),
		edited: new Set(fileOps.edited),
	};
}

function mergeFileOps(left: FileOperations, right: FileOperations): FileOperations {
	const merged = cloneFileOps(left);
	for (const file of right.read) merged.read.add(file);
	for (const file of right.written) merged.written.add(file);
	for (const file of right.edited) merged.edited.add(file);
	return merged;
}

function toolResultRunEndIndex(entries: EntryRecord[], startIndex: number): number {
	let index = startIndex;
	while (index < entries.length && messageRole(entries[index]) === "toolResult") index++;
	return index;
}

function toolResultRunStartIndex(entries: EntryRecord[], entryIndex: number): number {
	let index = entryIndex;
	while (index > 0 && messageRole(entries[index - 1]) === "toolResult") index--;
	return index;
}

function isCompleteToolResultRunAfterAssistant(
	entries: EntryRecord[],
	assistantIndex: number,
	resultStartIndex: number,
): boolean {
	const resultEndIndex = toolResultRunEndIndex(entries, resultStartIndex);
	return resultEndIndex > resultStartIndex
		&& toolResultIdsMatchAssistant(
			entries.slice(resultStartIndex, resultEndIndex).map((entry) => entry.message),
			entries[assistantIndex].message,
		);
}

function findOwningAssistantForToolResultRun(entries: EntryRecord[], resultIndex: number): number | undefined {
	const resultStartIndex = toolResultRunStartIndex(entries, resultIndex);
	const assistantIndex = resultStartIndex - 1;
	if (messageRole(entries[assistantIndex]) !== "assistant") return undefined;
	return isCompleteToolResultRunAfterAssistant(entries, assistantIndex, resultStartIndex) ? assistantIndex : undefined;
}

function findFirstProviderUnsafeEntryIndex(entries: EntryRecord[], startIndex: number): number | undefined {
	let index = startIndex;
	while (index < entries.length) {
		const role = messageRole(entries[index]);
		if (role === "assistant") {
			const nextIndex = index + 1;
			const toolCallIds = assistantToolCallIds(entries[index].message);
			if (!toolCallIds) return index;
			if (toolCallIds.length > 0 && messageRole(entries[nextIndex]) !== "toolResult") {
				return index;
			}
			if (messageRole(entries[nextIndex]) === "toolResult") {
				if (!isCompleteToolResultRunAfterAssistant(entries, index, nextIndex)) return nextIndex;
				index = toolResultRunEndIndex(entries, nextIndex);
				continue;
			}
		}
		if (role === "toolResult") return index;
		index++;
	}
	return undefined;
}

function suffixIsProviderSafe(entries: EntryRecord[], startIndex: number): boolean {
	return findFirstProviderUnsafeEntryIndex(entries, startIndex) === undefined;
}

function canStartKeptSuffixAt(entry: EntryRecord | undefined): boolean {
	return entry !== undefined && messageRole(entry) !== "toolResult";
}

function findProviderSafeStartAfter(entries: EntryRecord[], afterIndex: number): number | undefined {
	for (let index = afterIndex + 1; index < entries.length; index++) {
		if (!canStartKeptSuffixAt(entries[index])) continue;
		if (suffixIsProviderSafe(entries, index)) return index;
	}
	return undefined;
}

function buildPreparationForCut(
	preparation: ContinuationCompactionPreparation,
	entries: EntryRecord[],
	boundaryStart: number,
	firstKeptIndex: number | undefined,
	repairFlags: Pick<NormalizedCompactionPreparation, "repairedNoOpCut" | "repairedProviderUnsafeSuffix">,
): NormalizedCompactionPreparation {
	if (firstKeptIndex === undefined) {
		const messagesToSummarize = messagesFromEntryRange(entries, boundaryStart, entries.length);
		return {
			...preparation,
			firstKeptEntryId: NO_PRE_COMPACTION_MESSAGES_KEPT_ENTRY_ID,
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			fileOps: mergeFileOps(preparation.fileOps, extractFileOps(messagesToSummarize)),
			...repairFlags,
		};
	}
	const turnStartIndex = findTurnStartIndex(entries, firstKeptIndex, boundaryStart);
	const isSplitTurn = !isTurnStart(entries[firstKeptIndex])
		&& turnStartIndex !== undefined
		&& turnStartIndex < firstKeptIndex;
	const messagesToSummarize = messagesFromEntryRange(
		entries,
		boundaryStart,
		isSplitTurn ? turnStartIndex : firstKeptIndex,
	);
	const turnPrefixMessages = isSplitTurn ? messagesFromEntryRange(entries, turnStartIndex, firstKeptIndex) : [];
	const summarizedMessages = [...messagesToSummarize, ...turnPrefixMessages];
	return {
		...preparation,
		firstKeptEntryId: entries[firstKeptIndex].id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		fileOps: mergeFileOps(preparation.fileOps, extractFileOps(summarizedMessages)),
		...repairFlags,
	};
}

function repairProviderUnsafeKeptSuffix(
	preparation: ContinuationCompactionPreparation,
	entries: EntryRecord[],
): NormalizedCompactionPreparation | undefined {
	const firstKeptIndex = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
	if (firstKeptIndex < 0) return undefined;
	const firstUnsafeIndex = findFirstProviderUnsafeEntryIndex(entries, firstKeptIndex);
	if (firstUnsafeIndex === undefined) return undefined;
	const boundaryStart = findBoundaryStart(entries, firstKeptIndex);
	if (boundaryStart > firstKeptIndex) return undefined;
	const owningAssistantIndex = findOwningAssistantForToolResultRun(entries, firstUnsafeIndex);
	if (
		owningAssistantIndex !== undefined
		&& owningAssistantIndex >= boundaryStart
		&& owningAssistantIndex < firstKeptIndex
		&& suffixIsProviderSafe(entries, owningAssistantIndex)
	) {
		return buildPreparationForCut(preparation, entries, boundaryStart, owningAssistantIndex, {
			repairedNoOpCut: false,
			repairedProviderUnsafeSuffix: true,
		});
	}
	const safeStartIndex = findProviderSafeStartAfter(entries, firstUnsafeIndex);
	return buildPreparationForCut(preparation, entries, boundaryStart, safeStartIndex, {
		repairedNoOpCut: false,
		repairedProviderUnsafeSuffix: true,
	});
}

/**
 * Repair Pi preparations that would append a summary while keeping the whole branch.
 *
 * Pi can currently choose the branch root when the recent tool-result suffix alone crosses
 * `keepRecentTokens`. That produces empty `messagesToSummarize`, no file operations, and a
 * compaction that does not reduce context. For a completed assistant/tool-result batch, the safe
 * replacement cut is the assistant message that owns the suffix, with the earlier same-turn prefix
 * summarized separately.
 */
export function stripCompactionPreparationMessages<T extends ContinuationCompactionPreparation>(
	preparation: T,
	shouldStrip: (message: unknown) => boolean,
): T {
	return {
		...preparation,
		messagesToSummarize: preparation.messagesToSummarize.filter((message) => !shouldStrip(message)),
		turnPrefixMessages: preparation.turnPrefixMessages.filter((message) => !shouldStrip(message)),
	};
}

export function normalizeCompactionPreparation(
	preparation: ContinuationCompactionPreparation,
	branchEntries: unknown[],
): NormalizedCompactionPreparation {
	const entries = branchEntries.map(asEntry).filter((entry): entry is EntryRecord => entry !== undefined);
	const unsafeSuffixRepair = repairProviderUnsafeKeptSuffix(preparation, entries);
	if (unsafeSuffixRepair) return unsafeSuffixRepair;
	const assistantIndex = findCompletedToolResultSuffixAssistantIndex(entries);
	if (assistantIndex === undefined || !shouldRepairNoOpPreparation(preparation, entries, assistantIndex)) {
		return { ...preparation, repairedNoOpCut: false, repairedProviderUnsafeSuffix: false };
	}
	const boundaryStart = findBoundaryStart(entries, assistantIndex);
	if (boundaryStart >= assistantIndex) return { ...preparation, repairedNoOpCut: false, repairedProviderUnsafeSuffix: false };
	const turnStartIndex = findTurnStartIndex(entries, assistantIndex, boundaryStart);
	const isSplitTurn = turnStartIndex !== undefined && turnStartIndex < assistantIndex;
	const messagesToSummarize = messagesFromEntryRange(
		entries,
		boundaryStart,
		isSplitTurn ? turnStartIndex : assistantIndex,
	);
	const turnPrefixMessages = isSplitTurn ? messagesFromEntryRange(entries, turnStartIndex, assistantIndex) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return { ...preparation, repairedNoOpCut: false, repairedProviderUnsafeSuffix: false };
	}
	const summarizedMessages = [...messagesToSummarize, ...turnPrefixMessages];
	return {
		...preparation,
		firstKeptEntryId: entries[assistantIndex].id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		fileOps: extractFileOps(summarizedMessages),
		repairedNoOpCut: true,
		repairedProviderUnsafeSuffix: false,
	};
}
