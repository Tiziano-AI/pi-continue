import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPiInternals } from "../extensions/continue/src/pi-internals.ts";

const root = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const native = await import(pathToFileURL(join(root, "core", "compaction", "compaction.js")).href);
const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 12 };
const timestamp = "2026-07-25T12:00:00.000Z";

function entry(id: string, parentId: string | null, message: unknown) {
	return { type: "message", id, parentId, timestamp, message };
}

function user(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(id: string, path: string) {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		provider: "openai-codex",
		model: "gpt-5.4",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp,
	};
}

function result(id: string, text: string) {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

test("local token estimation matches Pi", async () => {
	const local = await loadPiInternals();
	const messages = [
		user("before"),
		{
			role: "assistant",
			content: [{ type: "text", text: "measured" }],
			provider: "openai-codex",
			model: "gpt-5.4",
			usage: { input: 80, output: 20, cacheRead: 4, cacheWrite: 2, totalTokens: 106, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp,
		},
		user("trailing context"),
	];
	assert.deepEqual(local.estimateContextTokens(messages), native.estimateContextTokens(messages));
});

test("local compaction preparation matches Pi for a completed tool batch", async () => {
	const local = await loadPiInternals();
	const entries = [
		entry("u1", null, user("old context ".repeat(20))),
		entry("a1", "u1", assistant("call-1", "/repo/old.ts")),
		entry("r1", "a1", result("call-1", "old result ".repeat(20))),
		entry("u2", "r1", user("recent request")),
		entry("a2", "u2", assistant("call-2", "/repo/recent.ts")),
		entry("r2", "a2", result("call-2", "recent result")),
	];
	assert.deepEqual(local.prepareCompaction(entries, settings), native.prepareCompaction(entries, settings));
});

test("local compaction preparation matches Pi after prior compaction", async () => {
	const local = await loadPiInternals();
	const entries = [
		entry("u1", null, user("retired context ".repeat(20))),
		entry("u2", "u1", user("kept context ".repeat(20))),
		{
			type: "compaction",
			id: "c1",
			parentId: "u2",
			timestamp,
			summary: "prior summary",
			firstKeptEntryId: "u2",
			tokensBefore: 200,
			details: { readFiles: ["/repo/prior.ts"], modifiedFiles: ["/repo/changed.ts"] },
		},
		entry("u3", "c1", user("new context ".repeat(20))),
		entry("a3", "u3", assistant("call-3", "/repo/new.ts")),
		entry("r3", "a3", result("call-3", "new result")),
	];
	assert.deepEqual(local.prepareCompaction(entries, settings), native.prepareCompaction(entries, settings));
});

test("local no-op preparation follows the host Pi contract", async () => {
	const local = await loadPiInternals();
	const entries = [entry("u1", null, user("recent"))];
	const config = { ...settings, keepRecentTokens: 20000 };
	assert.deepEqual(local.prepareCompaction(entries, config), native.prepareCompaction(entries, config));
});

test("local preparation matches Pi for custom and branch entries", async () => {
	const local = await loadPiInternals();
	const entries = [
		{ type: "custom_message", id: "c1", parentId: null, timestamp, customType: "fixture", content: "custom context", display: true },
		{ type: "branch_summary", id: "b1", parentId: "c1", timestamp, summary: "branch context", fromId: "source" },
		entry("u1", "b1", user("recent request")),
	];
	assert.deepEqual(local.prepareCompaction(entries, settings), native.prepareCompaction(entries, settings));
});

test("local preparation matches Pi null-content projection", async () => {
	const local = await loadPiInternals();
	const entries = [
		entry("u1", null, { role: "user", content: null, timestamp }),
		entry("u2", "u1", user("recent")),
	];
	const config = { ...settings, keepRecentTokens: 1 };
	assert.deepEqual(local.prepareCompaction(entries, config), native.prepareCompaction(entries, config));
});

test("local preparation matches Pi migration and empty-path behavior", async () => {
	const local = await loadPiInternals();
	const missing = [entry("", null, user("missing id"))];
	assert.deepEqual(local.prepareCompaction(missing, settings), native.prepareCompaction(missing, settings));
	const entries = [
		entry("u1", null, user("old context ".repeat(20))),
		entry("a1", "u1", assistant("call-1", "")),
		entry("r1", "a1", result("call-1", "result")),
		entry("u2", "r1", user("recent")),
	];
	assert.deepEqual(local.prepareCompaction(entries, settings), native.prepareCompaction(entries, settings));
});

test("local helpers match Pi across generated linear histories", async () => {
	const local = await loadPiInternals();
	let seed = 0x5eed1234;
	const random = (limit: number) => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed % limit;
	};
	for (let sample = 0; sample < 100; sample++) {
		const entries: unknown[] = [];
		const messages: unknown[] = [];
		let parent: string | null = null;
		const turns = random(6) + 1;
		for (let turn = 0; turn < turns; turn++) {
			const uid = `u-${sample}-${turn}`;
			const prompt = user("u".repeat(random(160) + 1));
			entries.push(entry(uid, parent, prompt));
			messages.push(prompt);
			parent = uid;
			const aid = `a-${sample}-${turn}`;
			const call = `call-${sample}-${turn}`;
			const tool = random(2) === 0;
			const response = tool ? assistant(call, random(4) === 0 ? "" : `/repo/${sample}-${turn}.ts`) : {
				role: "assistant",
				content: [{ type: "text", text: "a".repeat(random(120) + 1) }],
				provider: "openai-codex",
				model: "gpt-5.4",
				usage: { input: random(30), output: random(20), cacheRead: random(10), cacheWrite: random(5), totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: random(5) === 0 ? "error" : "stop",
				timestamp,
			};
			entries.push(entry(aid, parent, response));
			messages.push(response);
			parent = aid;
			if (!tool) continue;
			const rid = `r-${sample}-${turn}`;
			const output = result(call, "r".repeat(random(200) + 1));
			entries.push(entry(rid, parent, output));
			messages.push(output);
			parent = rid;
		}
		const config = { ...settings, keepRecentTokens: random(120) };
		assert.deepEqual(local.estimateContextTokens(messages), native.estimateContextTokens(messages), `token sample ${sample}`);
		assert.deepEqual(local.prepareCompaction(entries, config), native.prepareCompaction(entries, config), `preparation sample ${sample}`);
	}
});
