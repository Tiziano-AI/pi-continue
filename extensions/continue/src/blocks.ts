import type { HistoryArtifactParseResult, ParsedHistoryArtifacts } from "./types.ts";

const HISTORY_ARTIFACT_VERSION = "pi-continue-artifacts/v4";
const NO_AGENT_GUIDE_REPLACEMENT_REASON = "The handoff model returned no agent guide replacement.";
const UNEXPLAINED_AGENT_GUIDE_REPLACEMENT_REASON = "The handoff model returned an agent guide replacement without a reason, so no guide write was scheduled.";

const ESTABLISHED_BASIS = new Set<string>([
	"observed",
	"test",
	"output",
	"user",
	"doc",
]);

// Presentation wrappers commonly added around the JSON artifact by chat and
// local reasoning models. Candidates extracted from them are still validated
// against the full v4 contract before any of them is accepted.
const REASONING_BLOCK_PATTERN = /<(think|thinking|reasoning|reflection)>[\s\S]*?<\/\1>/gi;
const FENCED_BLOCK_PATTERN = /(?:^|\r?\n)[ \t]*(?:`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\r?\n|$)/g;

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

interface AgentGuideUpdate {
	content: string | undefined;
	reason: string;
}

function escapeTag(tag: string): string {
	return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
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

/** Collect every balanced top-level JSON object embedded in model output. */
function collectJsonObjectCandidates(text: string): string[] {
	const candidates: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (character !== "}" || depth === 0) continue;
		depth -= 1;
		if (depth === 0 && start >= 0) {
			candidates.push(text.slice(start, index + 1));
			start = -1;
		}
	}
	return candidates;
}

/**
 * Order the artifact payloads worth validating for one model response.
 *
 * The strict v4 contract still decides what is usable: this only looks past
 * presentation wrappers (reasoning tags, Markdown fences, surrounding prose)
 * that models add around an otherwise complete artifact.
 */
function artifactCandidates(text: string): string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();
	const add = (value: string): void => {
		const trimmed = value.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) return;
		seen.add(trimmed);
		ordered.push(trimmed);
	};
	add(text);
	const withoutReasoning = text.replace(REASONING_BLOCK_PATTERN, "\n");
	add(withoutReasoning);
	for (const match of withoutReasoning.matchAll(FENCED_BLOCK_PATTERN)) add(match[1]);
	for (const candidate of collectJsonObjectCandidates(withoutReasoning)) add(candidate);
	return ordered;
}

function parseForbidEntry(value: unknown): ForbidEntry | undefined {
	if (!isRecord(value)) return undefined;
	const rule = singleLineString(value.rule);
	const source = singleLineString(value.source);
	if (!rule || !source) return undefined;
	return { rule, source };
}

function parseEstablishedEntry(value: unknown): EstablishedEntry | undefined {
	if (!isRecord(value)) return undefined;
	const claim = singleLineString(value.claim);
	const evidence = singleLineString(value.evidence);
	const basis = singleLineString(value.basis);
	const reopen = singleLineString(value.reopen);
	if (!claim || !evidence || !basis || !reopen) return undefined;
	if (!ESTABLISHED_BASIS.has(basis)) return undefined;
	return { claim, evidence, basis, reopen };
}

function parseLearnedEntry(value: unknown): LearnedEntry | undefined {
	if (!isRecord(value)) return undefined;
	const lesson = singleLineString(value.lesson);
	const source = singleLineString(value.source);
	if (!lesson || !source) return undefined;
	return { lesson, source };
}

function parseOpenEntry(value: unknown): OpenEntry | undefined {
	if (!isRecord(value)) return undefined;
	const question = singleLineString(value.question);
	const verifies = singleLineString(value.verifies);
	if (!question || !verifies) return undefined;
	return { question, verifies };
}

function parseNextEntry(value: unknown): NextEntry | undefined {
	if (!isRecord(value)) return undefined;
	const action = singleLineString(value.action);
	const outcome = singleLineString(value.outcome);
	if (!action || !outcome) return undefined;
	return { action, outcome };
}

// Every brief slot must be present. An empty list is a valid statement about a
// slot; an absent list is an incomplete ledger the receiver cannot trust.
function parseEntryList<T>(value: unknown, parseEntry: (entry: unknown) => T | undefined): T[] | undefined {
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
	if (!isRecord(value)) return undefined;
	const task = singleLineString(value.task);
	const done_when = singleLineString(value.done_when);
	if (!task || !done_when) return undefined;
	const forbid = parseEntryList(value.forbid, parseForbidEntry);
	const established = parseEntryList(value.established, parseEstablishedEntry);
	const learned = parseEntryList(value.learned, parseLearnedEntry);
	const open = parseEntryList(value.open, parseOpenEntry);
	const next = parseEntryList(value.next, parseNextEntry);
	if (!forbid || !established || !learned || !open || !next) return undefined;
	return { task, done_when, forbid, established, learned, open, next };
}

// The guide is a file the package owns, so it is only ever rewritten from a
// complete replacement the model both provided and explained. Anything less is
// read as "no replacement" instead of discarding the whole ledger.
function parseAgentGuideUpdate(value: unknown): AgentGuideUpdate | undefined {
	if (value === undefined || value === null) return { content: undefined, reason: NO_AGENT_GUIDE_REPLACEMENT_REASON };
	if (!isRecord(value)) return undefined;
	const content = nonEmptyString(value.content);
	const reason = nonEmptyString(value.reason);
	if (content && !reason) return { content: undefined, reason: UNEXPLAINED_AGENT_GUIDE_REPLACEMENT_REASON };
	return { content, reason: reason ?? NO_AGENT_GUIDE_REPLACEMENT_REASON };
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

function readHistoryArtifacts(parsed: unknown): ParsedHistoryArtifacts | undefined {
	if (!isRecord(parsed)) return undefined;
	if (parsed.version !== HISTORY_ARTIFACT_VERSION) return undefined;
	const brief = parseBriefEnvelope(parsed.brief);
	if (!brief) return undefined;
	const agentGuideUpdate = parseAgentGuideUpdate(parsed.agentGuideUpdate);
	if (!agentGuideUpdate) return undefined;
	return {
		briefMarkdown: renderBriefEnvelope(brief),
		agentGuideMd: agentGuideUpdate.content,
		agentGuideChangeReason: agentGuideUpdate.reason,
	};
}

/** Extract the first XML-style tagged block from model output. */
export function extractTaggedBlock(text: string, tag: string): string | undefined {
	const pattern = new RegExp(`<${escapeTag(tag)}>([\\s\\S]*?)</${escapeTag(tag)}>`, "i");
	const match = text.match(pattern);
	const content = match?.[1]?.trim();
	return content && content.length > 0 ? content : undefined;
}

/** Parse the strict provider-portable JSON history artifact response. */
export function parseHistoryArtifacts(text: string): HistoryArtifactParseResult {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: false, code: "artifact-empty" };
	let sawJsonObject = false;
	const accepted = new Map<string, ParsedHistoryArtifacts>();
	for (const candidate of artifactCandidates(trimmed)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch (error) {
			if (error instanceof SyntaxError) continue;
			throw error;
		}
		if (!isRecord(parsed)) continue;
		sawJsonObject = true;
		const artifacts = readHistoryArtifacts(parsed);
		if (artifacts) accepted.set(JSON.stringify(artifacts), artifacts);
	}
	// One response must identify one handoff. Repeated copies of the same artifact
	// are the same handoff; competing artifacts are not, so they fail closed
	// instead of letting document order pick the receiver's memory.
	if (accepted.size === 1) return { ok: true, artifacts: [...accepted.values()][0] };
	if (accepted.size > 1) return { ok: false, code: "artifact-ambiguous" };
	return { ok: false, code: sawJsonObject ? "artifact-invalid-shape" : "artifact-invalid-json" };
}
