import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONTINUE_CONFIG } from "../extensions/continue/src/config.ts";
import {
	findProtectedToolCallStartIndex,
	planMechanicalShake,
	composeShakeSummary,
	applyOffloadPlaceholders,
} from "../extensions/continue/src/shake.ts";

const PREV_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function shakeConfig(overrides = {}) {
	return { ...DEFAULT_CONTINUE_CONFIG, ...overrides };
}

function branchMessageEntry(id, message) {
	return { type: "message", id, parentId: id, timestamp: "2026-05-25T12:00:00.000Z", message };
}

function assistantToolEntry(id, callId) {
	return branchMessageEntry(id, {
		role: "assistant",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "printf x" } }],
		stopReason: "toolUse",
		timestamp: 0,
	});
}

function toolResultEntry(id, callId, text, toolName = "bash") {
	return branchMessageEntry(id, {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	});
}

/** 构造批次：user + [assistant(toolCall) + toolResult] × rounds，前 bigRounds 个结果为大型输出。 */
function toolRounds(rounds, bigRounds, bigText = "y".repeat(20000), smallText = "ok") {
	const entries = [
		branchMessageEntry("user-0", { role: "user", content: [{ type: "text", text: "start" }], timestamp: 0 }),
	];
	for (let index = 1; index <= rounds; index += 1) {
		entries.push(assistantToolEntry(`asst-${index}`, `call-${index}`));
		entries.push(toolResultEntry(`res-${index}`, `call-${index}`, index <= bigRounds ? bigText : smallText));
	}
	return entries;
}

function withAgentDir(agentDir, work) {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		work();
	} finally {
		if (PREV_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = PREV_AGENT_DIR;
	}
}

test("shake plan elides oversized results before the protected recent tail and offloads originals", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-continue-shake-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-shake-cwd-"));
	try {
		withAgentDir(agentDir, () => {
			const entries = toolRounds(20, 5);
			const plan = planMechanicalShake({
				config: shakeConfig(),
				entries,
				contextWindow: 128000,
				cwd,
				sessionId: "session-shake",
			});
			assert.equal(plan.viable, true);
			assert.equal(plan.reason, "shaken");
			assert.equal(plan.firstKeptEntryId, "asst-6");
			assert.equal(plan.offloaded.length, 5);
			assert.match(plan.skeleton, /\[tool output offloaded: res-1/);
			assert.doesNotMatch(plan.skeleton, /y{1000}/);
			assert.match(plan.summary, /mechanically shaken/);
			assert.match(plan.summary, /retrieve with the read tool/);
			assert.match(plan.summary, /res-1/);
			const offloadDir = join(agentDir, "offload");
			assert.equal(existsSync(join(offloadDir, "index.jsonl")), true);
			const indexLines = readFileSync(join(offloadDir, "index.jsonl"), "utf8").trim().split("\n");
			assert.equal(indexLines.length, 5);
			const first = JSON.parse(indexLines[0]);
			assert.equal(first.entryId, "res-1");
			assert.equal(first.toolName, "bash");
			assert.equal(first.sessionId, "session-shake");
			assert.equal(existsSync(first.path), true);
			assert.match(readFileSync(first.path, "utf8"), /y{20000}/);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("shake plan falls back when savings stay below the minimum", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-continue-shake-agent-"));
	try {
		withAgentDir(agentDir, () => {
			// 只有一个 5000-token 结果，minSavings 默认 10000。
			const plan = planMechanicalShake({
				config: shakeConfig(),
				entries: toolRounds(20, 1, "z".repeat(20000)),
				contextWindow: 128000,
				cwd: "cwd",
				sessionId: "s",
			});
			assert.equal(plan.viable, false);
			assert.equal(plan.reason, "below-min-savings");
			assert.equal(plan.offloaded.length, 0);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("shake plan falls back when the whole history fits the protected tail", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-continue-shake-agent-"));
	try {
		withAgentDir(agentDir, () => {
			const plan = planMechanicalShake({
				config: shakeConfig(),
				entries: toolRounds(10, 8, "z".repeat(20000)),
				contextWindow: 128000,
				cwd: "cwd",
				sessionId: "s",
			});
			assert.equal(plan.viable, false);
			assert.equal(plan.reason, "no-regions");
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("shake plan falls back when the skeleton exceeds the budget percent", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-continue-shake-agent-"));
	try {
		withAgentDir(agentDir, () => {
			const entries = [
				branchMessageEntry("user-0", { role: "user", content: [{ type: "text", text: "a".repeat(12000) }], timestamp: 0 }),
				...toolRounds(20, 5),
			];
			const plan = planMechanicalShake({
				// 上下文 4000 tokens，预算 75% = 3000 tokens；骨架里的 user 长文本已超。
				config: shakeConfig({ shakeSummaryBudgetPercent: 75 }),
				entries,
				contextWindow: 4000,
				cwd: "cwd",
				sessionId: "s",
			});
			assert.equal(plan.viable, false);
			assert.equal(plan.reason, "over-budget");
			assert.equal(plan.offloaded.length, 0);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("shake plan is disabled by config", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-continue-shake-agent-"));
	try {
		withAgentDir(agentDir, () => {
			const plan = planMechanicalShake({
				config: shakeConfig({ shakeEnabled: false }),
				entries: toolRounds(20, 5),
				contextWindow: 128000,
				cwd: "cwd",
				sessionId: "s",
			});
			assert.equal(plan.viable, false);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("findProtectedToolCallStartIndex counts tool calls from the tail", () => {
	const entries = toolRounds(10, 0);
	const start = findProtectedToolCallStartIndex(entries, 3);
	assert.equal(start, 15); // asst-8 起保留：从尾数第 3 个 toolCall 是 asst-8
});

test("applyOffloadPlaceholders replaces markers with full paths and previews", () => {
	const skeleton = "a\n[tool output offloaded: res-1]\nb";
	const records = [{
		entryId: "res-1",
		toolName: "bash",
		tokens: 5000,
		path: "C:/offload/res-1.bash.txt",
		preview: "head of output",
	}];
	const next = applyOffloadPlaceholders(skeleton, records);
	assert.match(next, /\[tool output offloaded: res-1; bash, 5,000 tokens; path: C:\/offload\/res-1\.bash\.txt; preview: head of output\]/);
});

test("composeShakeSummary renders the offload index for retrieval", () => {
	const summary = composeShakeSummary("skeleton", [{
		entryId: "res-1",
		toolName: "bash",
		tokens: 5000,
		path: "C:/offload/res-1.bash.txt",
		preview: "head",
	}], 4960);
	assert.match(summary, /## Offloaded tool outputs/);
	assert.match(summary, /bash res-1: 5,000 tokens → C:\/offload\/res-1\.bash\.txt/);
	assert.match(summary, /saving ~4,960 tokens/);
});

test("shake plan skips entries before the previous compaction boundary", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-continue-shake-agent-"));
	try {
		withAgentDir(agentDir, () => {
			// 上一次压缩保留了 asst-6 起（asst-5 之前的条目已被摘要），摇树不应翻动边界前内容。
			const entries = [
				{ type: "compaction", id: "compact-1", parentId: "asst-5", firstKeptEntryId: "asst-5", summary: "previous" },
				...toolRounds(20, 5).slice(10), // res-5 之后：res-5, asst-6, res-6, ...
			];
			const plan = planMechanicalShake({
				config: shakeConfig({ shakeMinSavingsTokens: 2000 }),
				entries,
				contextWindow: 128000,
				cwd: "cwd",
				sessionId: "s",
			});
			// 边界后、保护区前的摇树区只有 res-5（大结果）；保护区从 asst-6 起。
			assert.equal(plan.viable, true);
			assert.equal(plan.offloaded.length, 1);
			assert.equal(plan.firstKeptEntryId, "asst-6");
			assert.match(plan.skeleton, /\[tool output offloaded: res-5/);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});