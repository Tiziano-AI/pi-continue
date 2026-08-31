import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	estimateContextTokens,
	prepareCompaction,
	renderConversationTranscript,
} from "../extensions/continue/src/compaction-planning.ts";

/**
 * Differential tests: the package's compaction planning must agree with the
 * implementation of the Pi release it is installed against. The native
 * implementation is imported by file path (test-only; the package itself must
 * never reach into Pi's `dist/`, which is what broke managed installs in
 * upstream issues #12 and #11).
 */

const PI_CODING_AGENT_DIST = join(
	process.cwd(),
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
);

const native = await import(join(PI_CODING_AGENT_DIST, "core", "compaction", "compaction.js"));

const SETTINGS: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 };
}

function assistantMessage(
	text: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		role: "assistant" as const,
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "text" as const, text }],
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 0,
		...overrides,
	};
}

function assistantToolMessage(toolCallId: string, path: string) {
	return assistantMessage("", {
		content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: { path } }],
		usage: {
			input: 45,
			output: 45,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 90,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
	});
}

function toolResultMessage(text: string, toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: 0,
	};
}

function entry(id: string, parentId: string | null, message: unknown) {
	return { type: "message" as const, id, parentId, timestamp: "2026-05-25T12:00:00.000Z", message };
}

function customMessageEntry(id: string, parentId: string | null, customType: string, content: unknown) {
	return {
		type: "custom_message" as const,
		id,
		parentId,
		customType,
		content,
		display: true,
		timestamp: "2026-05-25T12:00:00.000Z",
	};
}

function branchSummaryEntry(id: string, parentId: string | null, fromId: string, summary: string) {
	return {
		type: "branch_summary" as const,
		id,
		parentId,
		fromId,
		summary,
		timestamp: "2026-05-25T12:00:00.000Z",
	};
}

function compactionEntry(id: string, parentId: string | null, firstKeptEntryId: string, summary: string) {
	return {
		type: "compaction" as const,
		id,
		parentId,
		summary,
		firstKeptEntryId,
		tokensBefore: 500,
		timestamp: "2026-05-25T12:00:00.000Z",
	};
}

/** One completed user/assistant/tool-call/tool-result turn with a long recent suffix. */
function toolTurn(id: string, parentId: string | null, toolCallId: string, suffix: string) {
	return [
		entry(`${id}-user`, parentId, userMessage(`run tool ${"x".repeat(80)}`)),
		entry(`${id}-assistant`, `${id}-user`, assistantToolMessage(toolCallId, `/repo/${toolCallId}.ts`)),
		entry(`${id}-result`, `${id}-assistant`, toolResultMessage(suffix, toolCallId)),
	];
}

/** Compare the package planning against the installed Pi's own implementation. */
function assertSameAsNative(entries: unknown[], keepRecentTokens: number) {
	const settings = { ...SETTINGS, keepRecentTokens };
	const expected = (native.prepareCompaction as (e: unknown[], s: unknown) => unknown)(
		entries as never,
		settings as never,
	);
	const actual = prepareCompaction(entries as never, settings as never);
	if (expected === undefined) {
		assert.equal(actual, undefined, "Pi has no preparation, package must agree");
		return;
	}
	assert.notEqual(actual, undefined, "Pi has a preparation, package must produce one");
	const actualShape = actual as {
		firstKeptEntryId: string;
		messagesToSummarize: unknown[];
		turnPrefixMessages: unknown[];
		isSplitTurn: boolean;
		tokensBefore: number;
		previousSummary?: string;
	};
	assert.equal(actualShape.firstKeptEntryId, (expected as never as typeof actualShape).firstKeptEntryId);
	assert.equal(actualShape.isSplitTurn, (expected as never as typeof actualShape).isSplitTurn);
	assert.equal(actualShape.tokensBefore, (expected as never as typeof actualShape).tokensBefore);
	assert.equal(actualShape.previousSummary, (expected as never as typeof actualShape).previousSummary);
	assert.deepEqual(
		actualShape.messagesToSummarize,
		(expected as never as typeof actualShape).messagesToSummarize,
		"messagesToSummarize must match Pi's preparation",
	);
	assert.deepEqual(
		actualShape.turnPrefixMessages,
		(expected as never as typeof actualShape).turnPrefixMessages,
		"turnPrefixMessages must match Pi's preparation",
	);
}

test("estimateContextTokens matches Pi's internal implementation", () => {
	const cases: unknown[][] = [
		[],
		[userMessage("hi")],
		[userMessage("hi"), assistantMessage("hello, this is a longer reply with some text")],
		[
			userMessage("run tool"),
			assistantToolMessage("tool-1", "/repo/file.ts"),
			toolResultMessage("x".repeat(200), "tool-1"),
		],
		[
			assistantMessage("", { stopReason: "aborted" }),
			assistantMessage("done"),
			userMessage("trailing"),
		],
		[
			assistantMessage("", {
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			userMessage("trailing after zero-usage assistant"),
		],
	];
	for (const messages of cases) {
		const expected = (
			native.estimateContextTokens as (m: unknown[]) => {
				tokens: number;
				usageTokens: number;
				trailingTokens: number;
				lastUsageIndex: number | null;
			}
		)(messages as never);
		assert.deepEqual(estimateContextTokens(messages), expected, `estimate mismatch for ${JSON.stringify(messages)}`);
	}
});

test("single short turn has no compactable history", () => {
	assertSameAsNative(toolTurn("t1", null, "tool-1", "x"), 10);
});

test("two completed turns compact at the second turn boundary", () => {
	const entries = [
		...toolTurn("t1", null, "tool-1", "x".repeat(20)),
		...toolTurn("t2", "t1-result", "tool-2", "x".repeat(20)),
	];
	assertSameAsNative(entries, 10);
	assertSameAsNative(entries, 30);
	assertSameAsNative(entries, 20000);
});

test("longer session with several turns and split-turn cuts", () => {
	const entries = [
		...toolTurn("t1", null, "tool-1", "x".repeat(40)),
		...toolTurn("t2", "t1-result", "tool-2", "x".repeat(80)),
		...toolTurn("t3", "t2-result", "tool-3", "x".repeat(160)),
	];
	assertSameAsNative(entries, 10);
	assertSameAsNative(entries, 25);
	assertSameAsNative(entries, 60);
	assertSameAsNative(entries, 120);
	assertSameAsNative(entries, 20000);
});

test("branch with custom messages and branch summaries", () => {
	const entries = [
		entry("u1", null, userMessage("start")),
		entry("a1", "u1", assistantMessage("first reply")),
		customMessageEntry("c1", "a1", "pi-continue", "note"),
		branchSummaryEntry("b1", "c1", "a1", "explored a side branch"),
		...toolTurn("t2", "b1", "tool-1", "x".repeat(60)),
	];
	assertSameAsNative(entries, 10);
	assertSameAsNative(entries, 50);
});

test("session with a previous compaction continues from its boundary", () => {
	const entries = [
		entry("u0", null, userMessage("oldest")),
		entry("a0", "u0", assistantMessage("oldest reply")),
		compactionEntry("cmp", "a0", "u0", "summary of earlier work"),
		...toolTurn("t1", "cmp", "tool-1", "x".repeat(30)),
		...toolTurn("t2", "t1-result", "tool-2", "x".repeat(30)),
	];
	assertSameAsNative(entries, 10);
	assertSameAsNative(entries, 50);
});

test("branch ending in a compaction entry has no preparation", () => {
	const entries = [
		...toolTurn("t1", null, "tool-1", "x".repeat(40)),
		compactionEntry("cmp", "t1-result", "t1-user", "summary"),
	];
	assertSameAsNative(entries, 10);
});

test("empty branch has no preparation", () => {
	assertSameAsNative([], 10);
});

test("differential: user session corpus from the managed agent dir (if available)", { skip: process.env.PI_CONTINUE_CORPUS !== "1" }, async () => {
	const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
	if (!existsSync(sessionsDir)) return;
	const sessionFiles = readdirSync(sessionsDir, { recursive: true })
		.filter((name) => name.endsWith(".jsonl"))
		.slice(0, 3);
	assert.ok(sessionFiles.length > 0);
	for (const name of sessionFiles) {
		const path = String(name).startsWith("/") ? String(name) : join(sessionsDir, String(name));
		const rows = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line));
		for (const keepRecentTokens of [20000, 5000, 1000]) {
			assertSameAsNative(rows, keepRecentTokens);
		}
	}
});

test("renderConversationTranscript matches Pi's serializeConversation(convertToLlm(messages))", async () => {
	const messages = [
		userMessage("run tool"),
		assistantToolMessage("tool-1", "/repo/file.ts"),
		toolResultMessage("output text", "tool-1"),
	];
	const { convertToLlm } = await import(join(PI_CODING_AGENT_DIST, "core", "messages.js"));
	const { serializeConversation } = await import(join(PI_CODING_AGENT_DIST, "core", "compaction", "utils.js"));
	const expected = serializeConversation(convertToLlm(messages as never));
	assert.equal(renderConversationTranscript(messages), expected);
});

test("regression: package sources never resolve Pi internals by file path (issue #12)", () => {
	const root = join(process.cwd(), "extensions");
	const files = readdirSync(root, { recursive: true }).filter((name) => name.endsWith(".ts"));
	assert.ok(files.length > 0, "extension sources must exist");
	for (const name of files) {
		const path = String(name).startsWith("/") ? String(name) : join(root, String(name));
		const source = readFileSync(path, "utf8");
		assert.doesNotMatch(
			source,
			/import\.meta\.resolve\(\s*["']@earendil-works\//,
			`${name} must not import.meta.resolve Pi peer packages (bypasses the extension loader)`,
		);
		assert.doesNotMatch(
			source,
			/from\s+["']@earendil-works\/pi-coding-agent\/dist\//,
			`${name} must not import Pi dist modules by path`,
		);
		assert.doesNotMatch(
			source,
			/import\(\s*(pathToFileURL|join)\b/,
			`${name} must not build dynamic file-path imports of host modules`,
		);
	}
	assert.equal(existsSync(join(root, "continue", "src", "pi-internals.ts")), false, "pi-internals.ts must stay removed");
});
