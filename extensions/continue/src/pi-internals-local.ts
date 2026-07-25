import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FileOperations } from "./compaction-preparation.ts";
import type { Context, PiInternals, Settings } from "./pi-internals.ts";

type Api = typeof import("@earendil-works/pi-coding-agent");
type Message = Parameters<Api["estimateTokens"]>[0];
type Usage = Parameters<Api["calculateContextTokens"]>[0];
type Project = (entry: SessionEntry) => unknown[];

let host: Api;
let project: Project | undefined;
let acceptsZero = false;

function configure(api: Api): void {
	host = api;
	project = (api as unknown as { sessionEntryToContextMessages?: Project }).sessionEntryToContextMessages;
	acceptsZero = api.getLastAssistantUsage([{
		type: "message",
		id: "pi-continue-usage-probe",
		parentId: null,
		timestamp: "1970-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [],
			provider: "pi-continue",
			model: "usage-probe",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		},
	} as unknown as SessionEntry]) !== undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function usage(message: unknown): Usage | undefined {
	const value = record(message);
	if (!value || value.role !== "assistant" || value.stopReason === "aborted" || value.stopReason === "error") return undefined;
	const data = record(value.usage) as Usage | undefined;
	return data && (acceptsZero || host.calculateContextTokens(data) > 0) ? data : undefined;
}

function tokens(message: unknown): number {
	return host.estimateTokens(message as Message);
}

function context(messages: unknown[]): Context {
	let index = messages.length - 1;
	while (index >= 0 && !usage(messages[index])) index--;
	if (index < 0) {
		let total = 0;
		for (const message of messages) total += tokens(message);
		return { tokens: total, usageTokens: 0, trailingTokens: total, lastUsageIndex: null };
	}
	const measured = usage(messages[index]);
	if (!measured) throw new Error("Pi usage detection changed during context estimation");
	const base = host.calculateContextTokens(measured);
	let trailing = 0;
	for (let current = index + 1; current < messages.length; current++) trailing += tokens(messages[current]);
	return {
		tokens: base + trailing,
		usageTokens: base,
		trailingTokens: trailing,
		lastUsageIndex: index,
	};
}

function time(value: unknown): number {
	return new Date(value as string).getTime();
}

function custom(value: Record<string, unknown>): unknown {
	return {
		role: "custom",
		customType: value.customType,
		content: value.content,
		display: value.display,
		details: value.details,
		timestamp: time(value.timestamp),
	};
}

function branch(value: Record<string, unknown>): unknown | undefined {
	if (typeof value.summary !== "string" || typeof value.fromId !== "string") return undefined;
	return {
		role: "branchSummary",
		summary: value.summary,
		fromId: value.fromId,
		timestamp: time(value.timestamp),
	};
}

function message(entry: SessionEntry): unknown | undefined {
	const value = record(entry);
	if (!value || value.type === "compaction") return undefined;
	if (project) return project(entry)[0];
	if (value.type === "message") return value.message;
	if (value.type === "custom_message") return custom(value);
	if (value.type === "branch_summary") return branch(value);
	return undefined;
}

function paths(value: unknown, output: FileOperations): void {
	const data = record(value);
	if (!data || data.role !== "assistant" || !Array.isArray(data.content)) return;
	for (const item of data.content) {
		const block = record(item);
		const args = record(block?.arguments);
		const path = args?.path;
		if (block?.type !== "toolCall" || typeof block.name !== "string" || typeof path !== "string" || path.length === 0) continue;
		if (block.name === "read") output.read.add(path);
		if (block.name === "write") output.written.add(path);
		if (block.name === "edit") output.edited.add(path);
	}
}

function add(values: unknown, output: Set<string>): void {
	if (!Array.isArray(values)) return;
	for (const value of values) output.add(value as string);
}

function prior(entries: SessionEntry[], index: number, output: FileOperations): void {
	if (index < 0) return;
	const entry = record(entries[index]);
	if (!entry || entry.fromHook) return;
	const details = record(entry.details);
	if (!details) return;
	add(details.readFiles, output.read);
	add(details.modifiedFiles, output.edited);
}

function operations(messages: unknown[], entries: SessionEntry[], index: number): FileOperations {
	const output: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	prior(entries, index, output);
	for (const value of messages) paths(value, output);
	return output;
}

interface Scope {
	previous: number;
	start: number;
	summary?: string;
}

function scope(entries: SessionEntry[]): Scope | undefined {
	let previous = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (record(entries[index])?.type !== "compaction") continue;
		previous = index;
		break;
	}
	if (previous < 0) return { previous, start: 0 };
	const entry = record(entries[previous]);
	if (!entry) return undefined;
	const kept = entries.findIndex((item) => record(item)?.id === entry.firstKeptEntryId);
	return {
		previous,
		start: kept >= 0 ? kept : previous + 1,
		summary: typeof entry.summary === "string" ? entry.summary : undefined,
	};
}

function collect(entries: SessionEntry[], start: number, end: number): unknown[] {
	const output: unknown[] = [];
	for (let index = start; index < end; index++) {
		const value = message(entries[index]);
		if (value) output.push(value);
	}
	return output;
}

function prepare(entries: unknown[], settings: Settings): unknown | undefined {
	const path = entries as SessionEntry[];
	if (record(path.at(-1))?.type === "compaction") return undefined;
	const range = scope(path);
	if (!range) return undefined;
	const before = context(host.buildSessionContext(path).messages).tokens;
	const cut = host.findCutPoint(path, range.start, path.length, settings.keepRecentTokens);
	const first = record(path[cut.firstKeptEntryIndex]);
	if (typeof first?.id !== "string" || first.id.length === 0) return undefined;
	const history = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const messages = collect(path, range.start, history);
	const prefix = cut.isSplitTurn ? collect(path, cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
	if (messages.length === 0 && prefix.length === 0 && !acceptsZero) return undefined;
	const files = operations(messages, path, range.previous);
	for (const value of prefix) paths(value, files);
	return {
		firstKeptEntryId: first.id,
		messagesToSummarize: messages,
		turnPrefixMessages: prefix,
		isSplitTurn: cut.isSplitTurn,
		tokensBefore: before,
		previousSummary: range.summary,
		fileOps: files,
		settings,
	};
}

export function createPiInternals(api: Api): PiInternals {
	configure(api);
	return {
		prepareCompaction: prepare,
		estimateTokens: tokens,
		estimateContextTokens: context,
		convertToLlm: (messages) => api.convertToLlm(messages as Parameters<Api["convertToLlm"]>[0]),
		serializeConversation: (messages) => api.serializeConversation(messages as Parameters<Api["serializeConversation"]>[0]),
	};
}
