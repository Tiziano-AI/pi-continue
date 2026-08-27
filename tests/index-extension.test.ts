import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerContinueExtension from "../extensions/continue/index.ts";
import { buildContinuationArtifactPath } from "../extensions/continue/src/project.ts";
import { CONTINUATION_PROMPT } from "../extensions/continue/src/runtime.ts";
import { NO_PRE_COMPACTION_MESSAGES_KEPT_ENTRY_ID } from "../extensions/continue/src/compaction-preparation.ts";

function assistantMessage(stopReason = "stop") {
	return {
		role: "assistant",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "text", text: "continuing" }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 0,
	};
}

function highUsageAssistantMessage() {
	return {
		...assistantMessage("toolUse"),
		content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf x" } }],
		usage: { input: 45, output: 45, cacheRead: 0, cacheWrite: 0, totalTokens: 90, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function userMessage(text) {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	};
}

function toolResultMessage(text, toolCallId = "tool-1") {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function createFakePi(cwd) {
	const commands = new Map();
	const events = new Map();
	const sent = [];
	const sentOptions = [];
	return {
		commands,
		events,
		sent,
		sentOptions,
		registerCommand(name, command) {
			commands.set(name, command);
		},
		on(name, handler) {
			events.set(name, handler);
		},
		sendUserMessage(prompt, options) {
			sent.push(prompt);
			sentOptions.push(options);
		},
		getThinkingLevel() {
			return undefined;
		},
		async exec(command, args, options) {
			assert.equal(command, "git");
			assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
			return { stdout: options?.cwd ?? cwd, code: 0 };
		},
	};
}

function continuationArtifactJson(agentGuideContent: string | null = null) {
	const brief = {
		task: "Continue the task.",
		done_when: "A valid pi-continue/v4 continuation ledger is saved.",
		forbid: [{ rule: "Do not write guessed artifacts.", source: "user@msg-test-fixture" }],
		established: [{
			claim: "Compaction synthesis succeeded for this fixture.",
			evidence: "tests/index-extension.test.ts:1",
			basis: "test",
			reopen: "none",
		}],
		learned: [],
		open: [{
			question: "Does the next compaction also succeed?",
			verifies: "Run the next cycle and parse its artifact.",
		}],
		next: [{
			action: "Run the next validation step.",
			outcome: "A new established entry covers the validation result.",
		}],
	};
	return JSON.stringify({
		version: "pi-continue-artifacts/v4",
		brief,
		agentGuideUpdate: {
			content: agentGuideContent,
			reason: agentGuideContent ? "Write configured guide replacement." : "No guide write.",
		},
	});
}

function createCommandContext(cwd, custom) {
	let compactCount = 0;
	let compactOptions;
	let branchEntries = [];
	const statusCalls = [];
	const workingMessages = [];
	const ctx = {
		cwd,
		hasUI: true,
		model: { provider: "openai", id: "gpt-test", contextWindow: 128000 },
		modelRegistry: { getAvailable() { return []; } },
		sessionManager: {
			getBranch() { return branchEntries; },
			getLeafId() { return branchEntries.at(-1)?.id ?? null; },
			getSessionId() { return "session-test"; },
		},
		ui: {
			theme: { fg(_color, text) { return text; }, bold(text) { return text; } },
			async custom(factory, options) {
				return custom(factory, options);
			},
			notify() {},
			setStatus(_key, value) {
				statusCalls.push(value);
			},
			setWorkingMessage(message) {
				workingMessages.push(message);
			},
			setWorkingIndicator() {},
			getEditorComponent() {
				return undefined;
			},
			setEditorComponent() {},
			async editor() {},
			async select() { return undefined; },
			async input() { return undefined; },
			async confirm() { return false; },
		},
		getContextUsage() {
			return { tokens: 1000, percent: 1, contextWindow: 128000 };
		},
		isIdle() {
			return true;
		},
		abort() {},
		compact(options) {
			compactCount += 1;
			compactOptions = options;
		},
		async waitForIdle() {},
		get compactCount() {
			return compactCount;
		},
		get compactOptions() {
			return compactOptions;
		},
		setBranch(entries) {
			branchEntries = entries;
		},
		statusCalls,
		workingMessages,
	};
	return ctx;
}

function writeAgentGuideSyncConfig(cwd) {
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
		agentGuideSyncMode: "always",
	}), "utf8");
}

function writeArtifactOffConfig(cwd) {
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
		continuationArtifactMode: "off",
	}), "utf8");
}

function continuationArtifactPath(cwd) {
	return buildContinuationArtifactPath(cwd, "session-test");
}

function branchMessageEntry(id, parentId, message) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-25T12:00:00.000Z",
		message,
	};
}

function branchAssistantToolEntry(id, parentId, toolCallId, path) {
	return branchMessageEntry(id, parentId, {
		...assistantMessage("toolUse"),
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } }],
	});
}

function branchToolResultEntry(id, parentId, toolCallId, text, toolName = "read") {
	return branchMessageEntry(id, parentId, {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	});
}

// Pi can only prepare a native compaction when a turn boundary sits outside the recent
// keep window, so a compactable branch needs more than the turn Pi would keep whole.
function compactableToolBranch() {
	return [
		branchMessageEntry("branch-user", null, userMessage(`run tool ${"x".repeat(80)}`)),
		branchAssistantToolEntry("branch-assistant", "branch-user", "tool-1", "/repo/file.ts"),
		branchToolResultEntry("branch-result", "branch-assistant", "tool-1", "x"),
		branchMessageEntry("branch-user-2", "branch-result", userMessage(`keep going ${"y".repeat(80)}`)),
		branchAssistantToolEntry("branch-assistant-2", "branch-user-2", "tool-2", "/repo/other.ts"),
		branchToolResultEntry("branch-result-2", "branch-assistant-2", "tool-2", "y"),
	];
}

// Pi always reports what started a compaction. `manual` is what the package's own
// ctx.compact() request (and a user `/compact`) arrives as.
function compactionEvent(preparation = {}, branchEntries = [], reason = "manual") {
	return {
		preparation: {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "continue the task" }], timestamp: 0 }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1200,
			previousSummary: undefined,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200 },
			...preparation,
		},
		branchEntries,
		customInstructions: undefined,
		reason,
		willRetry: false,
		signal: new AbortController().signal,
	};
}

function ownedCompactionEvent(eventId = "continue-1", details = {}) {
	return {
		fromExtension: true,
		compactionEntry: {
			id: `compact-${eventId}`,
			summary: "<continuation>\nledger body\n</continuation>",
			details: { kind: "pi-continue/v4", readFiles: [], modifiedFiles: [], continuationEventId: eventId, ...details },
		},
	};
}

function assertNoFailedSynthesisSideEffects(cwd, pi) {
	assert.deepEqual(pi.sent, []);
	assert.equal(existsSync(join(cwd, "CONTINUE.md")), false);
	assert.equal(existsSync(continuationArtifactPath(cwd)), false);
	assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
}

test("extension registers only /continue and exact RPC-style /continue falls through to direct continuation", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	registerContinueExtension(pi);
	assert.deepEqual([...pi.commands.keys()], ["continue"]);
	const ctx = createCommandContext(cwd, async () => undefined);
	await pi.commands.get("continue").handler(undefined, ctx);
	assert.equal(ctx.compactCount, 1);
	assert.equal(ctx.workingMessages.at(-1), "pi-continue saving handoff");
	ctx.compactOptions.onComplete({});
	assert.equal(ctx.workingMessages.at(-1), "pi-continue verifying saved handoff");
	assert.deepEqual(pi.sent, []);
	await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
	assert.equal(ctx.workingMessages.at(-1), "pi-continue resuming this session");
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
	await pi.events.get("agent_end")({}, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
	await pi.events.get("message_start")({ message: assistantMessage() }, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
	await pi.commands.get("continue").handler(undefined, ctx);
	assert.equal(ctx.compactCount, 1);
	await pi.events.get("message_end")({ message: assistantMessage() }, ctx);
	assert.equal(ctx.workingMessages.at(-1), undefined);
	await pi.commands.get("continue").handler(undefined, ctx);
	assert.equal(ctx.compactCount, 2);
});

test("palette continuation dispatches resume as follow-up", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	const ctx = createCommandContext(cwd, async (factory) => {
		let selected;
		const component = factory({ requestRender() {} }, ctx.ui.theme, {}, (result) => {
			selected = result;
		});
		component.handleInput("enter");
		return selected;
	});
	registerContinueExtension(pi);
	await pi.commands.get("continue").handler(undefined, ctx);
	assert.equal(ctx.compactCount, 1);
	ctx.compactOptions.onComplete({});
	await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
});

test("queued follow-up message_start starts same-session resume proof", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	const ctx = createCommandContext(cwd, async () => undefined);
	ctx.isIdle = () => false;
	registerContinueExtension(pi);
	await pi.commands.get("continue").handler("steer", ctx);
	ctx.compactOptions.onComplete({});
	await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
	await pi.events.get("message_start")({ message: userMessage(CONTINUATION_PROMPT) }, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
	await pi.events.get("message_end")({ message: assistantMessage() }, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	assert.equal(ctx.workingMessages.at(-1), undefined);
});

test("mid-run guard dispatches resume as follow-up after context threshold proof", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-mid-run-dispatch-"));
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		ctx.setBranch(compactableToolBranch());
		let abortCount = 0;
		ctx.abort = () => {
			abortCount += 1;
		};
		registerContinueExtension(pi);
		await pi.events.get("context")({
			messages: [userMessage("run tool"), highUsageAssistantMessage(), toolResultMessage("x".repeat(160))],
		}, ctx);
		assert.equal(ctx.compactCount, 1);
		assert.equal(abortCount, 0, "ctx.compact() owns the active-run abort");
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("mid-run guard skips cleanly when Pi has no compactable session preparation", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-mid-run-no-compactable-"));
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 20000 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const notifications = [];
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		ctx.setBranch(compactableToolBranch());
		ctx.ui.notify = (message, type) => {
			notifications.push([message, type]);
		};
		let abortCount = 0;
		ctx.abort = () => {
			abortCount += 1;
		};
		registerContinueExtension(pi);
		const event = {
			messages: [userMessage("run tool"), highUsageAssistantMessage(), toolResultMessage("x")],
		};
		await pi.events.get("context")(event, ctx);
		await pi.events.get("context")(event, ctx);
		assert.equal(ctx.compactCount, 0);
		assert.equal(abortCount, 0);
		assert.deepEqual(pi.sent, []);
		assert.deepEqual(notifications, [[
			"automatic continuation skipped: Pi has no compactable session history yet; the over-threshold context is still within the recent keep window or static prompt overhead.",
			"warning",
		]]);
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		await pi.events.get("context")(event, ctx);
		assert.equal(ctx.compactCount, 1);
		assert.equal(abortCount, 0, "ctx.compact() owns the active-run abort");
		assert.equal(notifications.length, 2);
		assert.match(notifications[1][0], /^automatic continuation: saving handoff/);
		assert.equal(notifications[1][1], "info");
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("mid-run guard chains when the resumed assistant tool loop fills context again", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-mid-run-chain-"));
	try {
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
			showAfterCompact: false,
		}), "utf8");
		const pi = createFakePi(cwd);
		const notifications = [];
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		ctx.setBranch(compactableToolBranch());
		let abortCount = 0;
		ctx.abort = () => {
			abortCount += 1;
		};
		ctx.ui.notify = (message, type) => {
			notifications.push([message, type]);
		};
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
		await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
		await pi.events.get("message_end")({ message: highUsageAssistantMessage() }, ctx);
		assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
		await pi.events.get("context")({
			messages: [userMessage("continue tools"), highUsageAssistantMessage(), toolResultMessage("x".repeat(160))],
		}, ctx);
		assert.equal(ctx.compactCount, 2);
		assert.equal(abortCount, 0, "ctx.compact() owns the active-run abort");
		assert.equal(ctx.workingMessages.at(-1), "pi-continue saving handoff");
		assert.deepEqual(notifications, [
			["/continue steer: saving handoff.", "info"],
			["/continue steer: resume request sent.", "info"],
			["automatic continuation: saving handoff (130/100 tokens, threshold 80).", "info"],
		]);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent("continue-2"), ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT, CONTINUATION_PROMPT]);
		await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
		await pi.events.get("message_end")({ message: assistantMessage() }, ctx);
		assert.equal(ctx.workingMessages.at(-1), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("mid-run guard does not compact provider-unsafe orphan tool-result suffixes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-mid-run-orphan-"));
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		let aborted = false;
		ctx.abort = () => {
			aborted = true;
		};
		registerContinueExtension(pi);
		await pi.events.get("context")({
			messages: [userMessage("run tool"), highUsageAssistantMessage(), toolResultMessage("x".repeat(160), "other-tool")],
		}, ctx);
		assert.equal(ctx.compactCount, 0);
		assert.equal(aborted, false);
		assert.deepEqual(pi.sent, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("settings and reset reject invalid scope arguments without opening dialogs", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	const ctx = createCommandContext(cwd, async () => undefined);
	const notifications = [];
	let selects = 0;
	let confirms = 0;
	ctx.ui.notify = (message, type) => {
		notifications.push([message, type]);
	};
	ctx.ui.select = async () => {
		selects += 1;
		return undefined;
	};
	ctx.ui.confirm = async () => {
		confirms += 1;
		return false;
	};
	registerContinueExtension(pi);
	await pi.commands.get("continue").handler("settings global extra", ctx);
	await pi.commands.get("continue").handler("reset typo", ctx);
	assert.deepEqual(notifications, [
		["Usage: /continue settings [project|global]", "warning"],
		["Usage: /continue reset [project|global]", "warning"],
	]);
	assert.equal(selects, 0);
	assert.equal(confirms, 0);
});

test("settings dialog can edit the human handoff trigger", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-trigger-settings-"));
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: 68000 } }), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		const notifications = [];
		let settingsSelectCount = 0;
		ctx.ui.notify = (message, type) => {
			notifications.push([message, type]);
		};
		ctx.ui.select = async (title, options) => {
			if (title === "Continuation settings") {
				settingsSelectCount += 1;
				if (settingsSelectCount > 1) return "Done";
				const triggerOption = options.find((option) => option.startsWith("Handoff trigger:"));
				assert.equal(triggerOption, "Handoff trigger: 60,000 tokens");
				return triggerOption;
			}
			if (title === "Handoff trigger") {
				assert.deepEqual(options, [
					"Keep current (60,000 tokens)",
					"Set trigger token count",
					"Use inherited/default trigger for this scope",
				]);
				return "Set trigger token count";
			}
			return undefined;
		};
		ctx.ui.input = async (title, placeholder) => {
			assert.equal(title, "Handoff trigger");
			assert.equal(placeholder, "token count, for example 96000");
			return "96,000";
		};
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("settings project", ctx);
		const settings = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
		assert.deepEqual(settings, { compaction: { reserveTokens: 32000 } });
		assert.deepEqual(notifications, [["Updated project handoff trigger", "info"]]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent_end settles only a started continuation resume failure", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	const ctx = createCommandContext(cwd, async () => undefined);
	registerContinueExtension(pi);
	await pi.commands.get("continue").handler("steer", ctx);
	ctx.compactOptions.onComplete({});
	await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
	await pi.events.get("agent_end")({}, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	await pi.events.get("before_agent_start")({ prompt: "unrelated prompt" }, ctx);
	await pi.events.get("agent_end")({}, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
	await pi.events.get("agent_end")({}, ctx);
	assert.deepEqual(ctx.statusCalls, []);
});

test("message_end settles failed and aborted resume outcomes without footer status writes", async () => {
	const cwd = process.cwd();
	const failedPi = createFakePi(cwd);
	const failedCtx = createCommandContext(cwd, async () => undefined);
	registerContinueExtension(failedPi);
	await failedPi.commands.get("continue").handler("steer", failedCtx);
	failedCtx.compactOptions.onComplete({});
	await failedPi.events.get("session_compact")(ownedCompactionEvent(), failedCtx);
	await failedPi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, failedCtx);
	await failedPi.events.get("message_end")({ message: assistantMessage("length") }, failedCtx);
	assert.deepEqual(failedCtx.statusCalls, []);
	assert.equal(failedCtx.workingMessages.at(-1), undefined);

	const abortedPi = createFakePi(cwd);
	const abortedCtx = createCommandContext(cwd, async () => undefined);
	registerContinueExtension(abortedPi);
	await abortedPi.commands.get("continue").handler("steer", abortedCtx);
	abortedCtx.compactOptions.onComplete({});
	await abortedPi.events.get("session_compact")(ownedCompactionEvent(), abortedCtx);
	await abortedPi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, abortedCtx);
	await abortedPi.events.get("message_end")({ message: assistantMessage("aborted") }, abortedCtx);
	assert.deepEqual(abortedCtx.statusCalls, []);
	assert.equal(abortedCtx.workingMessages.at(-1), undefined);
});

test("session_compact native or invalid active handoff proof fails closed without resume", async () => {
	const cwd = process.cwd();
	const nativePi = createFakePi(cwd);
	const nativeCtx = createCommandContext(cwd, async () => undefined);
	registerContinueExtension(nativePi);
	await nativePi.commands.get("continue").handler("steer", nativeCtx);
	await nativePi.events.get("session_compact")({
		fromExtension: false,
		compactionEntry: { id: "native", summary: "native summary", details: { readFiles: [], modifiedFiles: [] } },
	}, nativeCtx);
	nativeCtx.compactOptions.onComplete({});
	assert.deepEqual(nativePi.sent, []);
	assert.deepEqual(nativeCtx.statusCalls, []);

	const invalidPi = createFakePi(cwd);
	const invalidCtx = createCommandContext(cwd, async () => undefined);
	registerContinueExtension(invalidPi);
	await invalidPi.commands.get("continue").handler("steer", invalidCtx);
	invalidCtx.compactOptions.onComplete({});
	await invalidPi.events.get("session_compact")({
		fromExtension: true,
		compactionEntry: { id: "invalid", summary: "invalid summary", details: { kind: "pi-continue/v4", readFiles: [] } },
	}, invalidCtx);
	assert.deepEqual(invalidPi.sent, []);
	assert.deepEqual(invalidCtx.statusCalls, []);

	const ownerlessPi = createFakePi(cwd);
	const ownerlessCtx = createCommandContext(cwd, async () => undefined);
	registerContinueExtension(ownerlessPi);
	await ownerlessPi.commands.get("continue").handler("steer", ownerlessCtx);
	ownerlessCtx.compactOptions.onComplete({});
	await ownerlessPi.events.get("session_compact")({
		fromExtension: true,
		compactionEntry: {
			id: "ownerless",
			summary: "<continuation>\nownerless summary\n</continuation>",
			details: { kind: "pi-continue/v4", readFiles: [], modifiedFiles: [] },
		},
	}, ownerlessCtx);
	assert.deepEqual(ownerlessPi.sent, []);
	assert.deepEqual(ownerlessCtx.statusCalls, []);

	const stalePi = createFakePi(cwd);
	const staleCtx = createCommandContext(cwd, async () => undefined);
	registerContinueExtension(stalePi);
	await stalePi.commands.get("continue").handler("steer", staleCtx);
	staleCtx.compactOptions.onComplete({});
	await stalePi.events.get("session_compact")({
		fromExtension: true,
		compactionEntry: {
			id: "stale",
			summary: "<continuation>\nstale summary\n</continuation>",
			details: { kind: "pi-continue/v4", readFiles: [], modifiedFiles: [], continuationEventId: "continue-stale" },
		},
	}, staleCtx);
	assert.deepEqual(stalePi.sent, []);
	assert.deepEqual(staleCtx.statusCalls, []);
});

test("session_compact ignores ownerless continuation details without overlay, writes, or resume", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	const notifications = [];
	let customCalls = 0;
	const ctx = createCommandContext(cwd, async () => {
		customCalls += 1;
		return undefined;
	});
	ctx.ui.notify = (message, type) => {
		notifications.push([message, type]);
	};
	registerContinueExtension(pi);
	await pi.events.get("session_compact")({
		fromExtension: true,
		compactionEntry: {
			id: "compact-1",
			summary: "<continuation>\nledger body\n</continuation>",
			details: { kind: "pi-continue/v4", readFiles: [], modifiedFiles: [] },
		},
	}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(notifications, []);
	assert.equal(customCalls, 0);
	assert.deepEqual(pi.sent, []);
});

test("stale session_compact does not replace the latest owned ledger", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	let rendered = "";
	const ctx = createCommandContext(cwd, async (factory) => {
		const component = factory({ requestRender() {} }, { fg(_color, text) { return text; }, bold(text) { return text; } }, {}, () => {});
		rendered = component.render(80).join("\n");
		return undefined;
	});
	registerContinueExtension(pi);
	await pi.commands.get("continue").handler("steer", ctx);
	ctx.compactOptions.onComplete({});
	await pi.events.get("session_compact")({
		fromExtension: true,
		compactionEntry: {
			id: "compact-1",
			summary: "<continuation>\nfirst ledger\n</continuation>",
			details: { kind: "pi-continue/v4", readFiles: [], modifiedFiles: [], continuationEventId: "continue-1" },
		},
	}, ctx);
	await pi.events.get("session_compact")({
		fromExtension: true,
		compactionEntry: {
			id: "compact-stale",
			summary: "<continuation>\nstale ledger\n</continuation>",
			details: { kind: "pi-continue/v4", readFiles: [], modifiedFiles: [], continuationEventId: "continue-stale" },
		},
	}, ctx);
	const compactCountBeforeRetry = ctx.compactCount;
	await pi.commands.get("continue").handler("steer", ctx);
	assert.equal(ctx.compactCount, compactCountBeforeRetry);
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	await pi.commands.get("continue").handler("ledger", ctx);
	assert.match(rendered, /first ledger/);
	assert.doesNotMatch(rendered, /stale ledger/);
	await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
	await pi.events.get("message_end")({ message: assistantMessage() }, ctx);
	assert.equal(ctx.workingMessages.at(-1), undefined);
});

test("native and invalid session_compact events after verified proof do not clear the pending resume", async () => {
	const cwd = process.cwd();
	for (const staleEvent of [
		{
			fromExtension: false,
			compactionEntry: { id: "native-late", summary: "native summary", details: { readFiles: [], modifiedFiles: [] } },
		},
		{
			fromExtension: true,
			compactionEntry: { id: "invalid-late", summary: "invalid summary", details: { kind: "pi-continue/v4", readFiles: [] } },
		},
	]) {
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		await pi.events.get("session_compact")(staleEvent, ctx);
		const compactCountBeforeRetry = ctx.compactCount;
		await pi.commands.get("continue").handler("steer", ctx);
		assert.equal(ctx.compactCount, compactCountBeforeRetry);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	}
});

test("verified proof is recorded before awaited ledger display work", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	const ctx = createCommandContext(cwd, async () => undefined);
	let blockProjectContext = false;
	let releaseProjectContext = () => {};
	const projectContextStarted = new Promise((resolveStarted) => {
		pi.exec = async (command, args, options) => {
			assert.equal(command, "git");
			assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
			if (blockProjectContext) {
				resolveStarted(undefined);
				await new Promise((resolve) => {
					releaseProjectContext = resolve;
				});
			}
			return { stdout: options?.cwd ?? cwd, code: 0 };
		};
	});
	registerContinueExtension(pi);
	await pi.commands.get("continue").handler("steer", ctx);
	ctx.compactOptions.onComplete({});
	blockProjectContext = true;
	const proofPromise = pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
	await projectContextStarted;
	await pi.events.get("session_compact")({
		fromExtension: true,
		compactionEntry: { id: "invalid-late", summary: "invalid summary", details: { kind: "pi-continue/v4", readFiles: [] } },
	}, ctx);
	assert.deepEqual(pi.sent, []);
	releaseProjectContext();
	await proofPromise;
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
});

test("verified proof can arrive before the compaction completion callback", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	const ctx = createCommandContext(cwd, async () => undefined);
	registerContinueExtension(pi);
	await pi.commands.get("continue").handler("steer", ctx);
	await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
	assert.deepEqual(pi.sent, []);
	ctx.compactOptions.onComplete({});
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
});

test("session_compact ledger display is transient UI and sends only the same-session resume prompt", async () => {
	const cwd = process.cwd();
	const pi = createFakePi(cwd);
	let customCalls = 0;
	const ctx = createCommandContext(cwd, async (factory) => {
		customCalls += 1;
		factory({ requestRender() {} }, { fg(_color, text) { return text; }, bold(text) { return text; } }, {}, () => {});
		return undefined;
	});
	registerContinueExtension(pi);
	await pi.commands.get("continue").handler("steer", ctx);
	ctx.compactOptions.onComplete({});
	await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(customCalls, 1);
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
});

test("session_before_compact and session_compact write default artifact and configured agent guide only after a successful compaction", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-sync-success-"));
	const faux = fauxProvider();
	try {
		writeAgentGuideSyncConfig(cwd);
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson("# Agent Guide\n\nDurable rule.\n"))]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent({
			isSplitTurn: true,
			turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "split turn prefix" }], timestamp: 0 }],
		}), ctx);
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		assert.equal(existsSync(join(cwd, "CONTINUE.md")), false);
		assert.equal(existsSync(continuationArtifactPath(cwd)), false);
		assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
		assert.deepEqual(pi.sent, []);
		const summary = result.compaction.summary;
		assert.match(summary, /<continuation>/);
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-success",
				summary,
				details: result.compaction.details,
			},
		}, ctx);
		assert.equal(existsSync(join(cwd, "CONTINUE.md")), false);
		const artifactContent = readFileSync(continuationArtifactPath(cwd), "utf8");
		assert.match(artifactContent, /## Task\nContinue the task\./);
		assert.match(artifactContent, /## Established/);
		assert.match(readFileSync(join(cwd, "AGENTS.md"), "utf8"), /Durable rule/);
		assert.deepEqual(pi.sent, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a fenced modeled ledger completes the package-owned compaction and resumes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-fenced-handoff-"));
	const faux = fauxProvider();
	try {
		const fencedArtifact = ["```json", continuationArtifactJson(), "```"].join("\n");
		faux.setResponses([fauxAssistantMessage(fencedArtifact)]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-fenced",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		}, ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function overThresholdCompactionEvent(reason = "threshold") {
	return compactionEvent({
		tokensBefore: 130,
		settings: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
	}, [], reason);
}

// Adoption requires proof that the assistant just finished its own turn, which is
// what Pi's automatic threshold compaction follows.
async function completeAssistantTurn(pi, ctx) {
	await pi.events.get("message_end")({ message: assistantMessage() }, ctx);
	await pi.events.get("agent_end")({ messages: [] }, ctx);
}

test("Pi's own over-threshold compaction is adopted as a package handoff", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-adopt-"));
	const faux = fauxProvider();
	try {
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 100 };
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await completeAssistantTurn(pi, ctx);
		const result = await pi.events.get("session_before_compact")(overThresholdCompactionEvent(), ctx);
		assert.ok("compaction" in result);
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		assert.equal(ctx.compactCount, 0, "Pi already owns the compaction operation");
		assert.deepEqual(pi.sent, []);
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-adopted",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		}, ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		assert.match(readFileSync(continuationArtifactPath(cwd), "utf8"), /## Task\nContinue the task\./);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("below-threshold, manual, and opted-out compactions keep Pi's own summarizer", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-adopt-optout-"));
	try {
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		registerContinueExtension(pi);

		// A /compact request reports its own trigger, with or without a finished turn.
		assert.equal(await pi.events.get("session_before_compact")(overThresholdCompactionEvent("manual"), ctx), undefined);
		await completeAssistantTurn(pi, ctx);
		assert.equal(await pi.events.get("session_before_compact")(overThresholdCompactionEvent("manual"), ctx), undefined);

		// Context-overflow recovery is Pi's to resume.
		await completeAssistantTurn(pi, ctx);
		assert.equal(await pi.events.get("session_before_compact")(overThresholdCompactionEvent("overflow"), ctx), undefined);

		// New user input takes the checkpoint away from the finished turn.
		await completeAssistantTurn(pi, ctx);
		await pi.events.get("input")({ text: "keep going", source: "interactive" }, ctx);
		assert.equal(await pi.events.get("session_before_compact")(overThresholdCompactionEvent(), ctx), undefined);

		// Below the threshold there is nothing to own.
		await completeAssistantTurn(pi, ctx);
		assert.equal(await pi.events.get("session_before_compact")(compactionEvent({}, [], "threshold"), ctx), undefined);

		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
			adoptNativeCompaction: false,
		}), "utf8");
		assert.equal(await pi.events.get("session_before_compact")(overThresholdCompactionEvent(), ctx), undefined);
		assert.deepEqual(pi.sent, []);
		assert.equal(existsSync(continuationArtifactPath(cwd)), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a concurrent compaction does not reuse the in-flight handoff owner", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-adopt-concurrent-"));
	const faux = fauxProvider();
	try {
		let releaseFirstAttempt;
		let synthesisCalls = 0;
		faux.setResponses([
			(() => {
				synthesisCalls += 1;
				return new Promise((resolve) => {
					releaseFirstAttempt = () => resolve(fauxAssistantMessage(continuationArtifactJson()));
				});
			}),
			(() => {
				synthesisCalls += 1;
				return fauxAssistantMessage(continuationArtifactJson());
			}),
		]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 100 };
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await completeAssistantTurn(pi, ctx);

		const inFlight = pi.events.get("session_before_compact")(overThresholdCompactionEvent(), ctx);
		assert.deepEqual(
			await pi.events.get("session_before_compact")(overThresholdCompactionEvent(), ctx),
			{ cancel: true },
			"a concurrent compaction is cancelled instead of summarizing the same branch in parallel",
		);
		for (let waits = 0; !releaseFirstAttempt && waits < 200; waits += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(releaseFirstAttempt, "the first compaction reached ledger synthesis");
		releaseFirstAttempt();
		const result = await inFlight;

		assert.ok("compaction" in result);
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		assert.equal(synthesisCalls, 1, "the concurrent compaction does not run a second synthesis");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// Pi's own ctx.compact() aborts the active run, and Pi reads that aborted turn as an
// error response that is over the threshold, so it starts an automatic compaction of the
// same branch while the package-owned request is still waiting for Pi to go idle.
function abortedRunAssistantMessage() {
	return { ...assistantMessage("error"), content: [], errorMessage: "This operation was aborted" };
}

function savedCompactionEvent(compaction, id = "compact-owned") {
	return {
		fromExtension: true,
		compactionEntry: { id, summary: compaction.summary, details: compaction.details },
	};
}

test("Pi's own compaction cannot race the package-owned handoff request", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-owned-race-"));
	const faux = fauxProvider();
	try {
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 100 };
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.setBranch(compactableToolBranch());
		registerContinueExtension(pi);
		await pi.events.get("context")({
			messages: [userMessage("run tool"), highUsageAssistantMessage(), toolResultMessage("x".repeat(160))],
		}, ctx);
		assert.equal(ctx.compactCount, 1);

		// Pi's aborted-run compaction arrives before Pi runs the package-owned request.
		await pi.events.get("message_end")({ message: abortedRunAssistantMessage() }, ctx);
		await pi.events.get("agent_end")({ messages: [] }, ctx);
		assert.deepEqual(
			await pi.events.get("session_before_compact")(overThresholdCompactionEvent("threshold"), ctx),
			{ cancel: true },
			"the package-owned request stays the single owner of the branch",
		);

		const result = await pi.events.get("session_before_compact")(overThresholdCompactionEvent("manual"), ctx);
		assert.ok("compaction" in result, "the package-owned request still saves its own handoff");
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(savedCompactionEvent(result.compaction), ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a handoff another compaction already saved resumes instead of failing", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-owned-saved-elsewhere-"));
	const faux = fauxProvider();
	try {
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
			continuationArtifactMode: "off",
			showAfterCompact: false,
		}), "utf8");
		const pi = createFakePi(cwd);
		const notifications = [];
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 100 };
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.ui.notify = (message, type) => {
			notifications.push([message, type]);
		};
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		assert.equal(ctx.compactCount, 1);

		// A `/compact` request is not Pi's own automatic compaction, so it is not cancelled;
		// it saves the package-owned handoff of the active event before Pi runs that request.
		const result = await pi.events.get("session_before_compact")(overThresholdCompactionEvent("manual"), ctx);
		assert.ok("compaction" in result);
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		await pi.events.get("session_compact")(savedCompactionEvent(result.compaction), ctx);
		assert.deepEqual(pi.sent, [], "resume waits until the package-owned request settles");

		ctx.compactOptions.onError(new Error("Already compacted"));
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT], "the saved handoff proof still resumes the session");
		assert.deepEqual(notifications, [
			["/continue steer: saving handoff.", "info"],
			["/continue steer: another compaction already saved this handoff.", "warning"],
			["/continue steer: resume request sent.", "info"],
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an adopted compaction without a usable handoff is handed back to Pi", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-adopt-release-"));
	const faux = fauxProvider();
	try {
		faux.setResponses([fauxAssistantMessage("not json"), fauxAssistantMessage("still not json")]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 100 };
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await completeAssistantTurn(pi, ctx);
		assert.equal(await pi.events.get("session_before_compact")(overThresholdCompactionEvent(), ctx), undefined);
		assertNoFailedSynthesisSideEffects(cwd, pi);

		// A released checkpoint is spent; the next adoption needs the next finished turn.
		assert.equal(await pi.events.get("session_before_compact")(overThresholdCompactionEvent(), ctx), undefined);

		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		await completeAssistantTurn(pi, ctx);
		const recovered = await pi.events.get("session_before_compact")(overThresholdCompactionEvent(), ctx);
		assert.ok("compaction" in recovered, "a released checkpoint does not block the next adoption");
		assert.equal(recovered.compaction.details.continuationEventId, "continue-2");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a reminded second synthesis attempt recovers a handoff from a non-compliant first response", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-artifact-retry-"));
	const faux = fauxProvider({ models: [{ id: "faux-reasoning", reasoning: true }] });
	try {
		const prompts = [];
		const reasoningLevels = [];
		const recordAttempt = (context, options) => {
			prompts.push(JSON.stringify(context));
			reasoningLevels.push(options?.reasoning);
		};
		faux.setResponses([
			((context, options) => {
				recordAttempt(context, options);
				return fauxAssistantMessage("I cannot produce that handoff as JSON right now.");
			}),
			((context, options) => {
				recordAttempt(context, options);
				return fauxAssistantMessage(continuationArtifactJson());
			}),
		]);
		const pi = createFakePi(cwd);
		pi.getThinkingLevel = () => "high";
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.ok("compaction" in result);
		assert.equal(prompts.length, 2);
		assert.doesNotMatch(prompts[0], /artifact-format-retry/);
		assert.match(prompts[1], /artifact-format-retry/);
		assert.deepEqual(reasoningLevels, ["high", undefined], "the retry frees the output budget from reasoning tokens");
		const usage = result.compaction.details.synthesis.history.usage;
		assert.equal(result.compaction.details.synthesis.totalTokens, usage.totalTokens);
		assert.ok(usage.output > 0, "both synthesis attempts are reported");
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-retry",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		}, ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact summarizes provider-unsafe kept suffixes before returning compaction proof", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-provider-safe-"));
	const faux = fauxProvider();
	try {
		let observedPrompt = "";
		faux.setResponses([((context) => {
			observedPrompt = JSON.stringify(context);
			return fauxAssistantMessage(continuationArtifactJson());
		})]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const branchEntries = [
			{ type: "model_change", id: "model", parentId: null, provider: "openai-codex", modelId: "gpt-5.5" },
			branchMessageEntry("u1", "model", userMessage("inspect")),
			branchAssistantToolEntry("a1", "u1", "call-a", "/repo/a.ts"),
			branchToolResultEntry("tr1", "a1", "call-a", "file a"),
			branchAssistantToolEntry("a2", "tr1", "call-b", "/repo/b.ts"),
			branchToolResultEntry("tr2", "a2", "call-b", "file b"),
			branchToolResultEntry("orphan", "tr2", "call-orphan", "late child output", "agent_team"),
		];
		const result = await pi.events.get("session_before_compact")(compactionEvent({
			firstKeptEntryId: "a1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
		}, branchEntries), ctx);

		assert.equal(result.compaction.firstKeptEntryId, NO_PRE_COMPACTION_MESSAGES_KEPT_ENTRY_ID);
		assert.deepEqual(result.compaction.details.readFiles, ["/repo/a.ts", "/repo/b.ts"]);
		assert.match(observedPrompt, /late child output/);
		assert.deepEqual(pi.sent, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact omits stale continuation docs and prior artifacts from provider prompt", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-no-stale-input-"));
	const faux = fauxProvider();
	try {
		writeFileSync(join(cwd, "CONTINUE.md"), "STALE_CONTINUE_SENTINEL", "utf8");
		mkdirSync(join(cwd, ".pi", "continue"), { recursive: true });
		writeFileSync(continuationArtifactPath(cwd), "STALE_ARTIFACT_SENTINEL", "utf8");
		let observedPrompt = "";
		faux.setResponses([((context) => {
			observedPrompt = JSON.stringify(context);
			return fauxAssistantMessage(continuationArtifactJson());
		})]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.ok("compaction" in result);
		assert.doesNotMatch(observedPrompt, /STALE_CONTINUE_SENTINEL/);
		assert.doesNotMatch(observedPrompt, /STALE_ARTIFACT_SENTINEL/);
		assert.doesNotMatch(observedPrompt, /existing-continuation-md/);
		assert.doesNotMatch(observedPrompt, /continuation-doc-path/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("continuationArtifactMode off suppresses successful artifact writes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-artifact-off-"));
	const faux = fauxProvider();
	try {
		writeArtifactOffConfig(cwd);
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.ok("compaction" in result);
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-artifact-off",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		}, ctx);
		assert.equal(existsSync(continuationArtifactPath(cwd)), false);
		assert.equal(existsSync(join(cwd, "CONTINUE.md")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("session_before_compact clamps history output budget to model max tokens", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-output-clamp-"));
	const faux = fauxProvider({ models: [{ id: "small-output", reasoning: false, maxTokens: 256 }] });
	try {
		let observedMaxTokens;
		faux.setResponses([(_context, options) => {
			observedMaxTokens = options?.maxTokens;
			return fauxAssistantMessage(continuationArtifactJson());
		}]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent({
			settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200 },
		}), ctx);
		assert.ok("compaction" in result);
		assert.equal(observedMaxTokens, 256);
		assert.equal(result.compaction.details.synthesis.history.outputBudget.requestedTokens, 800);
		assert.equal(result.compaction.details.synthesis.history.outputBudget.effectiveTokens, 256);
		assert.equal(result.compaction.details.synthesis.history.outputBudget.clampedByModel, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact cancels instead of returning ownerless details when ownership is lost during synthesis", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-owner-lost-"));
	const faux = fauxProvider();
	try {
		let releaseResponse = () => {};
		const providerStarted = new Promise((resolveStarted) => {
			faux.setResponses([async () => {
				resolveStarted(undefined);
				await new Promise((resolve) => {
					releaseResponse = resolve;
				});
				return fauxAssistantMessage(continuationArtifactJson());
			}]);
		});
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const compactionPromise = pi.events.get("session_before_compact")(compactionEvent(), ctx);
		await providerStarted;
		await pi.events.get("session_shutdown")({ reason: "reload" }, ctx);
		releaseResponse();
		const result = await compactionPromise;
		assert.deepEqual(result, { cancel: true });
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact does not attribute an old synthesis to a newer continuation owner", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-owner-replaced-"));
	const faux = fauxProvider();
	try {
		let releaseResponse = () => {};
		const providerStarted = new Promise((resolveStarted) => {
			faux.setResponses([async () => {
				resolveStarted(undefined);
				await new Promise((resolve) => {
					releaseResponse = resolve;
				});
				return fauxAssistantMessage(continuationArtifactJson());
			}]);
		});
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const compactionPromise = pi.events.get("session_before_compact")(compactionEvent(), ctx);
		await providerStarted;
		await pi.events.get("session_shutdown")({ reason: "reload" }, ctx);
		await pi.commands.get("continue").handler("steer", ctx);
		assert.equal(ctx.compactCount, 2);
		releaseResponse();
		const result = await compactionPromise;
		assert.deepEqual(result, { cancel: true });
		assertNoFailedSynthesisSideEffects(cwd, pi);
		const compactCountBeforeRetry = ctx.compactCount;
		await pi.commands.get("continue").handler("steer", ctx);
		assert.equal(ctx.compactCount, compactCountBeforeRetry);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("late compaction for abandoned owner does not fail a newer active handoff", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-late-abandoned-owner-"));
	const faux = fauxProvider();
	try {
		writeAgentGuideSyncConfig(cwd);
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson("# Agent Guide\n\nOld abandoned guide.\n"))]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const oldResult = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.equal(oldResult.compaction.details.continuationEventId, "continue-1");
		await pi.events.get("session_shutdown")({ reason: "reload" }, ctx);
		await pi.commands.get("continue").handler("steer", ctx);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "old-compact",
				summary: oldResult.compaction.summary,
				details: oldResult.compaction.details,
			},
		}, ctx);
		assert.deepEqual(pi.sent, []);
		assert.equal(existsSync(continuationArtifactPath(cwd)), false);
		assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
		await pi.events.get("session_compact")(ownedCompactionEvent("continue-2"), ctx);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact fails closed when ledger synthesis cannot authenticate", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-hard-fail-"));
	try {
		writeAgentGuideSyncConfig(cwd);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
			ok: false,
			error: "provider auth failed",
		});
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact fails closed when ledger synthesis times out", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-timeout-hard-fail-"));
	const faux = fauxProvider();
	try {
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
			agentGuideSyncMode: "always",
			synthesisTimeoutMs: 1,
		}), "utf8");
		faux.setResponses([(_context, options) => new Promise((resolve) => {
			const resolveAborted = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
			if (options?.signal?.aborted) {
				resolveAborted();
				return;
			}
			options?.signal?.addEventListener("abort", resolveAborted, { once: true });
		})]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const startedAt = Date.now();
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		assert.ok(Date.now() - startedAt < 1000);
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a truncated handoff response reports the output-limit cause when it fails closed", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-truncated-"));
	const faux = fauxProvider();
	try {
		const truncated = () => fauxAssistantMessage(continuationArtifactJson().slice(0, 120), { stopReason: "length" });
		faux.setResponses([truncated(), truncated()]);
		const notifications = [];
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.ui.notify = (message, type) => {
			notifications.push([message, type]);
		};
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		ctx.compactOptions.onError(new Error("Compaction cancelled"));
		assert.match(
			notifications.at(-1)[0],
			/handoff failed: pi-continue could not create a usable handoff, so continuation stopped before resuming\. Cause: response stopped at the output token limit/,
		);
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact fails closed when history artifacts are malformed", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-hard-fail-"));
	const faux = fauxProvider();
	try {
		writeAgentGuideSyncConfig(cwd);
		faux.setResponses([fauxAssistantMessage("not json")]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact cancels active package-owned compaction if config becomes disabled", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-disabled-active-"));
	try {
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({ enabled: false }), "utf8");
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact opts out when no extension-owned continuation event is active", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-optout-"));
	try {
		writeAgentGuideSyncConfig(cwd);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		registerContinueExtension(pi);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.equal(result, undefined);
		assert.deepEqual(pi.sent, []);
		assert.equal(existsSync(join(cwd, "CONTINUE.md")), false);
		assert.equal(existsSync(continuationArtifactPath(cwd)), false);
		assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact rejects wrong current artifact shape from the synthesizer", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-shape-reject-"));
	const faux = fauxProvider();
	try {
		writeAgentGuideSyncConfig(cwd);
		const wrongEnvelope = JSON.stringify({
			version: "pi-continue-artifacts/v4",
			brief: { task: "x" },
			agentGuideUpdate: { content: null, reason: "shape is incomplete" },
		});
		faux.setResponses([fauxAssistantMessage(wrongEnvelope)]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getProvider = () => faux.provider;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
