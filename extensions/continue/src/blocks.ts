import type { HistoryArtifactParseResult, ParsedHistoryArtifacts } from "./types.ts";

const HISTORY_ARTIFACT_VERSION = "pi-continue-artifacts/v4";

const ESTABLISHED_BASIS = new Set<string>([
	"observed",
	"test",
	"output",
	"user",
	"doc",
]);

const HISTORY_ARTIFACT_KEYS = ["version", "brief", "agentGuideUpdate"] as const;
const BRIEF_KEYS = ["task", "done_when", "forbid", "established", "learned", "open", "next"] as const;
const FORBID_KEYS = ["rule", "source"] as const;
const ESTABLISHED_KEYS = ["claim", "evidence", "basis", "reopen"] as const;
const LEARNED_KEYS = ["lesson", "source"] as const;
const OPEN_KEYS = ["question", "verifies"] as const;
const NEXT_KEYS = ["action", "outcome"] as const;
const AGENT_GUIDE_UPDATE_KEYS = ["content", "reason"] as const;

interface ForbidEntry {
	rule: string;
	source: string;
}

interface EstablishedEntry {
	claim: string;
	evidence: string;
	basis: string;
	reopen: string;
}

interface LearnedEntry {
	lesson: string;
	source: string;
}

interface OpenEntry {
	question: string;
	verifies: string;
}

interface NextEntry {
	action: string;
	outcome: string;
}

interface BriefEnvelope {
	task: string;
	done_when: string;
	forbid: ForbidEntry[];
	established: EstablishedEntry[];
	learned: LearnedEntry[];
	open: OpenEntry[];
	next: NextEntry[];
}

function escapeTag(tag: string): string {
	return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
	const keys = Object.keys(value);
	if (keys.length !== expectedKeys.length) return false;
	const expected = new Set<string>(expectedKeys);
	return keys.every((key) => expected.has(key));
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function nullableString(value: unknown): string | undefined {
	return value === null ? undefined : nonEmptyString(value);
}

// Collapse any newlines and embedded markdown bullet markers in a per-entry field
// to a single space, so the rendered brief stays one-bullet-per-entry and the next
// synthesizer cannot re-atomize sub-lines the synthesizer accidentally embedded.
function singleLineString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const collapsed = value
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
		.filter((line) => line.length > 0)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return collapsed.length > 0 ? collapsed : undefined;
}

function parseForbidEntry(value: unknown): ForbidEntry | undefined {
	if (!isRecord(value) || !hasExactKeys(value, FORBID_KEYS)) return undefined;
	const rule = singleLineString(value.rule);
	const source = singleLineString(value.source);
	if (!rule || !source) return undefined;
	return { rule, source };
}

function parseEstablishedEntry(value: unknown): EstablishedEntry | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ESTABLISHED_KEYS)) return undefined;
	const claim = singleLineString(value.claim);
	const evidence = singleLineString(value.evidence);
	const basis = singleLineString(value.basis);
	const reopen = singleLineString(value.reopen);
	if (!claim || !evidence || !basis || !reopen) return undefined;
	if (!ESTABLISHED_BASIS.has(basis)) return undefined;
	return { claim, evidence, basis, reopen };
}

function parseLearnedEntry(value: unknown): LearnedEntry | undefined {
	if (!isRecord(value) || !hasExactKeys(value, LEARNED_KEYS)) return undefined;
	const lesson = singleLineString(value.lesson);
	const source = singleLineString(value.source);
	if (!lesson || !source) return undefined;
	return { lesson, source };
}

function parseOpenEntry(value: unknown): OpenEntry | undefined {
	if (!isRecord(value) || !hasExactKeys(value, OPEN_KEYS)) return undefined;
	const question = singleLineString(value.question);
	const verifies = singleLineString(value.verifies);
	if (!question || !verifies) return undefined;
	return { question, verifies };
}

function parseNextEntry(value: unknown): NextEntry | undefined {
	if (!isRecord(value) || !hasExactKeys(value, NEXT_KEYS)) return undefined;
	const action = singleLineString(value.action);
	const outcome = singleLineString(value.outcome);
	if (!action || !outcome) return undefined;
	return { action, outcome };
}

function parseEntryArray<T>(value: unknown, parseEntry: (entry: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: T[] = [];
	for (const entry of value) {
		const parsed = parseEntry(entry);
		if (!parsed) return undefined;
		result.push(parsed);
	}
	return result;
}

function parseBriefEnvelope(value: unknown): BriefEnvelope | undefined {
	if (!isRecord(value) || !hasExactKeys(value, BRIEF_KEYS)) return undefined;
	const task = singleLineString(value.task);
	const done_when = singleLineString(value.done_when);
	if (!task || !done_when) return undefined;
	const forbid = parseEntryArray(value.forbid, parseForbidEntry);
	const established = parseEntryArray(value.established, parseEstablishedEntry);
	const learned = parseEntryArray(value.learned, parseLearnedEntry);
	const open = parseEntryArray(value.open, parseOpenEntry);
	const next = parseEntryArray(value.next, parseNextEntry);
	if (!forbid || !established || !learned || !open || !next) return undefined;
	return { task, done_when, forbid, established, learned, open, next };
}

function renderEntrySection<T>(title: string, entries: T[], renderEntry: (entry: T) => string): string | undefined {
	if (entries.length === 0) return undefined;
	return [`## ${title}`, ...entries.map(renderEntry)].join("\n");
}

function renderForbidEntry(entry: ForbidEntry): string {
	return `- ${entry.rule} — source: ${entry.source}`;
}

function renderEstablishedEntry(entry: EstablishedEntry): string {
	return `- ${entry.claim} — evidence: ${entry.evidence}; basis: ${entry.basis}; reopen: ${entry.reopen}`;
}

function renderLearnedEntry(entry: LearnedEntry): string {
	return `- ${entry.lesson} — source: ${entry.source}`;
}

function renderOpenEntry(entry: OpenEntry): string {
	return `- ${entry.question} — verifies: ${entry.verifies}`;
}

function renderNextEntry(entry: NextEntry): string {
	return `- ${entry.action} → ${entry.outcome}`;
}

function renderBriefEnvelope(brief: BriefEnvelope): string {
	const sections = [
		`## Task\n${brief.task}`,
		`## Done When\n${brief.done_when}`,
		renderEntrySection("Forbid", brief.forbid, renderForbidEntry),
		renderEntrySection("Established", brief.established, renderEstablishedEntry),
		renderEntrySection("Learned", brief.learned, renderLearnedEntry),
		renderEntrySection("Open", brief.open, renderOpenEntry),
		renderEntrySection("Next", brief.next, renderNextEntry),
	].filter((section): section is string => section !== undefined && section.length > 0);
	return sections.join("\n\n");
}

/** Extract the first XML-style tagged block from model output. */
export function extractTaggedBlock(text: string, tag: string): string | undefined {
	const pattern = new RegExp(`<${escapeTag(tag)}>([\\s\\S]*?)</${escapeTag(tag)}>`, "i");
	const match = text.match(pattern);
	const content = match?.[1]?.trim();
	return content && content.length > 0 ? content : undefined;
}

/**
 * Best-effort recovery of a JSON object from common ways smaller/local models
 * disobey the "return only the raw JSON object, no fences, no prose" instruction:
 * wrapping the object in a markdown code fence, or adding a sentence of prose
 * before or after it. Returns the original text unchanged if neither pattern
 * is found, so callers can distinguish "nothing to retry" from "found a
 * candidate."
 */
function extractJsonCandidate(text: string): string {
	const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
	if (fenced?.[1]?.trim()) return fenced[1].trim();
	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
	return text;
}

/**
 * Best-effort recovery for a specific misplacement smaller/local models produce after
 * generating a long, deeply nested brief: emitting `agentGuideUpdate` as the last key
 * inside `brief` instead of as `brief`'s sibling, as if it were just one more brief slot.
 * A no-op unless the top level is missing `agentGuideUpdate` and `brief` has it, so a
 * genuinely malformed or duplicated shape still falls through to the unchanged checks below.
 */
function recoverMisplacedAgentGuideUpdate(parsed: Record<string, unknown>): Record<string, unknown> {
	if ("agentGuideUpdate" in parsed) return parsed;
	const brief = parsed.brief;
	if (!isRecord(brief) || !("agentGuideUpdate" in brief)) return parsed;
	const { agentGuideUpdate, ...restBrief } = brief;
	return { ...parsed, brief: restBrief, agentGuideUpdate };
}

/** Parse the strict provider-portable JSON history artifact response. */
export function parseHistoryArtifacts(text: string): HistoryArtifactParseResult {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: false, code: "artifact-empty" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		const candidate = extractJsonCandidate(trimmed);
		if (candidate === trimmed) return { ok: false, code: "artifact-invalid-json" };
		try {
			parsed = JSON.parse(candidate);
		} catch (retryError) {
			if (retryError instanceof SyntaxError) return { ok: false, code: "artifact-invalid-json" };
			throw retryError;
		}
	}
	if (!isRecord(parsed)) return { ok: false, code: "artifact-invalid-shape" };
	const recovered = recoverMisplacedAgentGuideUpdate(parsed);
	if (!hasExactKeys(recovered, HISTORY_ARTIFACT_KEYS)) return { ok: false, code: "artifact-invalid-shape" };
	if (recovered.version !== HISTORY_ARTIFACT_VERSION) return { ok: false, code: "artifact-invalid-shape" };
	const brief = parseBriefEnvelope(recovered.brief);
	if (!brief) return { ok: false, code: "artifact-invalid-shape" };
	if (!isRecord(recovered.agentGuideUpdate) || !hasExactKeys(recovered.agentGuideUpdate, AGENT_GUIDE_UPDATE_KEYS)) return { ok: false, code: "artifact-invalid-shape" };
	const rawContent = recovered.agentGuideUpdate.content;
	if (rawContent !== null && nonEmptyString(rawContent) === undefined) return { ok: false, code: "artifact-invalid-shape" };
	const agentGuideMd = rawContent === null ? undefined : nullableString(rawContent);
	const agentGuideChangeReason = nonEmptyString(recovered.agentGuideUpdate.reason);
	if (!agentGuideChangeReason) return { ok: false, code: "artifact-invalid-shape" };
	return {
		ok: true,
		artifacts: {
			briefMarkdown: renderBriefEnvelope(brief),
			agentGuideMd,
			agentGuideChangeReason,
		},
	};
}
