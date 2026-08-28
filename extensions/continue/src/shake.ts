import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveAgentDir } from "./agent-dir.ts";
import type { ContinuationConfig } from "./types.ts";

/** 机械摇树的结果记录，既写入全局 index 也用于摘要索引段。 */
export interface OffloadRecord {
	entryId: string;
	toolName: string;
	tokens: number;
	path: string;
	preview: string;
}

export interface MechanicalShakePlan {
	viable: boolean;
	reason: "no-regions" | "below-min-savings" | "over-budget" | "shaken";
	savingsTokens: number;
	skeleton: string;
	skeletonTokens: number;
	summary: string;
	firstKeptEntryId: string;
	offloaded: OffloadRecord[];
}

interface EntryRecord {
	type: string;
	id: string;
	message?: unknown;
	firstKeptEntryId?: unknown;
}

interface MessageRecord {
	role?: string;
	content?: unknown;
	toolName?: unknown;
}

interface TextBlock {
	type: string;
	text?: unknown;
}

interface ToolCallBlock {
	type: string;
	name?: unknown;
	id?: unknown;
	arguments?: unknown;
}

const PLACEHOLDER_TOKEN_ESTIMATE = 40;
const PREVIEW_LENGTH = 200;
const TOOL_ARGUMENT_PREVIEW_LENGTH = 400;
const SHAKE_MARKER_PREFIX = "[tool output offloaded: ";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asEntry(value: unknown): EntryRecord | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.type === "string" && typeof value.id === "string"
		? { ...value, type: value.type, id: value.id }
		: undefined;
}

function asMessage(value: unknown): MessageRecord | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.role === "string" ? { ...value, role: value.role } : undefined;
}

function messageOf(entry: EntryRecord): MessageRecord | undefined {
	return asMessage(entry.message);
}

function textBlocks(message: MessageRecord): string[] {
	if (!Array.isArray(message.content)) return [];
	const blocks: string[] = [];
	for (const block of message.content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") blocks.push(block.text);
	}
	return blocks;
}

function toolCallsIn(message: MessageRecord): ToolCallBlock[] {
	if (!Array.isArray(message.content)) return [];
	return message.content.filter((block): block is ToolCallBlock => isRecord(block) && block.type === "toolCall");
}

function estimateTokens(text: string): number {
	return Math.max(0, Math.round(text.length / 4));
}

function clip(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function safeToolName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 0 ? sanitized : "tool";
}

function shortHash(input: string): string {
	let hash = 5381;
	for (let index = 0; index < input.length; index += 1) {
		hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** 与 Pi 相同的压缩边界：上次压缩保留的首条，或上个压缩条目之后。 */
export function findBoundaryStartIndex(entries: EntryRecord[]): number {
	let prevCompactionIndex = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index].type === "compaction") {
			prevCompactionIndex = index;
			break;
		}
	}
	if (prevCompactionIndex < 0) return 0;
	const firstKeptEntryId = entries[prevCompactionIndex].firstKeptEntryId;
	if (typeof firstKeptEntryId !== "string") return prevCompactionIndex + 1;
	const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	return firstKeptIndex >= 0 ? firstKeptIndex : prevCompactionIndex + 1;
}

/**
 * 从尾部向前定位保护区的起点：累计最近 `protectedToolCalls` 次工具调用，
 * 返回包含第 `protectedToolCalls` 个 toolCall 的 assistant 条目索引；不足则 undefined。
 */
export function findProtectedToolCallStartIndex(entries: EntryRecord[], protectedToolCalls: number): number | undefined {
	let remaining = protectedToolCalls;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = asEntry(entries[index]);
		if (!entry || entry.type !== "message") continue;
		const message = messageOf(entry);
		if (message?.role !== "assistant") continue;
		const callCount = toolCallsIn(message).length;
		if (callCount <= 0) continue;
		remaining -= callCount;
		if (remaining <= 0) return index;
	}
	return undefined;
}

interface ShakeRegion {
	index: number;
	entryId: string;
	toolName: string;
	text: string;
	tokens: number;
}

/** 收集摇树区内超过阈值的 toolResult 原文区域。 */
export function collectShakeRegions(
	entries: EntryRecord[],
	startIndex: number,
	endIndex: number,
	thresholdTokens: number,
): ShakeRegion[] {
	const regions: ShakeRegion[] = [];
	for (let index = startIndex; index < endIndex; index += 1) {
		const entry = asEntry(entries[index]);
		if (!entry || entry.type !== "message") continue;
		const message = messageOf(entry);
		if (message?.role !== "toolResult") continue;
		const text = textBlocks(message).join("\n");
		const tokens = estimateTokens(text);
		if (tokens < thresholdTokens) continue;
		const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
		regions.push({ index, entryId: entry.id, toolName, text, tokens });
	}
	return regions;
}

/** 机械摇树路径的骨架占位符（不含路径的标记版，最终替换为完整占位符）。 */
export function shakeMarker(entryId: string): string {
	return `${SHAKE_MARKER_PREFIX}${entryId}]`;
}

/** 把骨架中的标记替换为含 offload 路径与预览的完整占位符。 */
export function applyOffloadPlaceholders(skeleton: string, records: OffloadRecord[]): string {
	let next = skeleton;
	for (const record of records) {
		const marker = shakeMarker(record.entryId);
		const placeholder = `${marker.slice(0, -1)}; ${record.toolName}, ${record.tokens.toLocaleString()} tokens; path: ${record.path}; preview: ${record.preview}]`;
		next = next.split(marker).join(placeholder);
	}
	return next;
}

/** 把摇树区构建成对话骨架：达到阈值的 toolResult 换成标记，其余原样保留。 */
export function buildShakeSkeleton(entries: EntryRecord[], startIndex: number, endIndex: number, thresholdTokens: number): string {
	const bigResultEntryIds = new Set<string>();
	for (let index = startIndex; index < endIndex; index += 1) {
		const entry = asEntry(entries[index]);
		if (!entry || entry.type !== "message") continue;
		const message = messageOf(entry);
		if (message?.role !== "toolResult") continue;
		const tokens = estimateTokens(textBlocks(message).join("\n"));
		if (tokens >= thresholdTokens) bigResultEntryIds.add(entry.id);
	}
	const lines: string[] = [];
	for (let index = startIndex; index < endIndex; index += 1) {
		const entry = asEntry(entries[index]);
		if (!entry || entry.type !== "message") continue;
		const message = messageOf(entry);
		if (!message) continue;
		if (message.role === "toolResult") {
			if (bigResultEntryIds.has(entry.id)) {
				lines.push(shakeMarker(entry.id));
				continue;
			}
			const text = textBlocks(message).join("\n");
			if (text.length > 0) lines.push(text);
			continue;
		}
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) continue;
			const parts: string[] = [];
			for (const block of message.content) {
				if (!isRecord(block)) continue;
				if (block.type === "text" && typeof block.text === "string") {
					parts.push(block.text);
				} else if (block.type === "toolCall") {
					const name = typeof block.name === "string" ? block.name : "tool";
					const callId = typeof block.id === "string" ? block.id : entry.id;
					const argsJson = JSON.stringify(block.arguments ?? {});
					parts.push(`[toolCall: ${name} ${callId} args ${clip(argsJson, TOOL_ARGUMENT_PREVIEW_LENGTH)}]`);
				}
			}
			if (parts.length > 0) lines.push(parts.join("\n"));
			continue;
		}
		if (message.role === "user") {
			const text = textBlocks(message).join("\n");
			if (text.length > 0) lines.push(text);
		}
	}
	return lines.join("\n\n");
}

function offloadRoot(): string {
	return join(resolveAgentDir(), "offload");
}

/** 把被摇的原文写入全局 offload 目录并追加索引；任何失败都向上抛出以回退 LLM。 */
export function writeOffloadFiles(
	regions: ShakeRegion[],
	cwd: string,
	sessionId: string,
): { slug: string; records: OffloadRecord[] } {
	const slug = `${safeToolName(basename(cwd) || "project")}-${shortHash(cwd)}`;
	const dir = join(offloadRoot(), slug);
	mkdirSync(dir, { recursive: true });
	const records: OffloadRecord[] = [];
	for (const region of regions) {
		const fileName = `${region.entryId}.${safeToolName(region.toolName)}.txt`;
		const absolutePath = join(dir, fileName);
		writeFileSync(absolutePath, region.text, "utf8");
		const preview = clip(region.text.replace(/\s+/g, " ").trim(), PREVIEW_LENGTH) || "(empty)";
		const record: OffloadRecord = {
			entryId: region.entryId,
			toolName: region.toolName,
			tokens: region.tokens,
			path: absolutePath,
			preview,
		};
		records.push(record);
		appendFileSync(
			join(offloadRoot(), "index.jsonl"),
			`${JSON.stringify({ ...record, sessionId, offloadedAt: new Date().toISOString() })}\n`,
			"utf8",
		);
	}
	return { slug, records };
}

/** 把摇树骨架与 offload 索引组装成压缩摘要，供主模型恢复后按需找回。 */
export function composeShakeSummary(skeleton: string, offloaded: OffloadRecord[], savingsTokens: number): string {
	const header = `# Continuation (mechanically shaken)\n\nThis handoff elided ${offloaded.length} oversized tool output${offloaded.length === 1 ? "" : "s"} (saving ~${savingsTokens.toLocaleString()} tokens) without an LLM summary. Recent tool rounds were kept intact.`;
	const indexLines = offloaded.map((record) => {
		return `- ${record.toolName} ${record.entryId}: ${record.tokens.toLocaleString()} tokens → ${record.path}`;
	});
	const indexBlock = offloaded.length > 0
		? `\n\n## Offloaded tool outputs (retrieve with the read tool when needed)\n${indexLines.join("\n")}`
		: "";
	return `${header}\n\n${skeleton}${indexBlock}`;
}

export interface MechanicalShakeInput {
	config: ContinuationConfig;
	entries: unknown[];
	contextWindow: number;
	cwd: string;
	sessionId: string;
}

/**
 * 评估机械摇树路径：优先保护区、计算收益与骨架预算，收益与预算达标则执行 offload
 * 并组装摘要。viable=false 表示应回退 LLM 摘要；offload 写入失败会向上抛出。
 */
export function planMechanicalShake(input: MechanicalShakeInput): MechanicalShakePlan {
	const config = input.config;
	if (!config.shakeEnabled) {
		return { viable: false, reason: "no-regions", savingsTokens: 0, skeleton: "", skeletonTokens: 0, summary: "", firstKeptEntryId: "", offloaded: [] };
	}
	const entries = input.entries.map(asEntry).filter((entry): entry is EntryRecord => entry !== undefined);
	if (entries.length === 0) {
		return { viable: false, reason: "no-regions", savingsTokens: 0, skeleton: "", skeletonTokens: 0, summary: "", firstKeptEntryId: "", offloaded: [] };
	}
	const boundaryStart = findBoundaryStartIndex(entries);
	const protectedStart = findProtectedToolCallStartIndex(entries, config.shakeProtectedToolCalls);
	if (protectedStart === undefined || protectedStart <= boundaryStart) {
		return { viable: false, reason: "no-regions", savingsTokens: 0, skeleton: "", skeletonTokens: 0, summary: "", firstKeptEntryId: entries[boundaryStart]?.id ?? "", offloaded: [] };
	}
	const regions = collectShakeRegions(entries, boundaryStart, protectedStart, config.shakeThresholdTokens);
	const savingsTokens = regions.reduce((total, region) => total + Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE), 0);
	if (savingsTokens < config.shakeMinSavingsTokens) {
		return { viable: false, reason: "below-min-savings", savingsTokens, skeleton: "", skeletonTokens: 0, summary: "", firstKeptEntryId: entries[boundaryStart]?.id ?? "", offloaded: [] };
	}
	const skeletonWithMarkers = buildShakeSkeleton(entries, boundaryStart, protectedStart, config.shakeThresholdTokens);
	const skeletonTokens = estimateTokens(skeletonWithMarkers);
	const budgetTokens = Math.floor(input.contextWindow * config.shakeSummaryBudgetPercent / 100);
	if (skeletonTokens > budgetTokens) {
		return { viable: false, reason: "over-budget", savingsTokens, skeleton: skeletonWithMarkers, skeletonTokens, summary: "", firstKeptEntryId: entries[boundaryStart]?.id ?? "", offloaded: [] };
	}
	const { records } = writeOffloadFiles(regions, input.cwd, input.sessionId);
	const skeleton = applyOffloadPlaceholders(skeletonWithMarkers, records);
	return {
		viable: true,
		reason: "shaken",
		savingsTokens,
		skeleton,
		skeletonTokens,
		summary: composeShakeSummary(skeleton, records, savingsTokens),
		firstKeptEntryId: entries[protectedStart].id,
		offloaded: records,
	};
}