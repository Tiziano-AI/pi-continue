import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerContinueExtension from "../extensions/continue/index.ts";
import { buildContinuationArtifactPath } from "../extensions/continue/src/project.ts";
import { CONTINUATION_PROMPT } from "../extensions/continue/src/runtime.ts";
import { SHAKE_CONTINUATION_PROMPT } from "../extensions/continue/src/continuation-prompt.ts";
import { NO_PRE_COMPACTION_MESSAGES_KEPT_ENTRY_ID } from "../extensions/continue/src/compaction-preparation.ts";
import { WorkflowCoordination } from "../extensions/continue/src/workflow-coordination.ts";

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
	const lifecycleEvents = [];
	events.emit = (channel, data) => {
		lifecycleEvents.push([channel, data]);
	};
	const sent = [];
	const sentOptions = [];
	return {
		commands,
		events,
		lifecycleEvents,
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

function enableWorkflowBus(pi) {
	const subscribers = new Map();
	pi.events.on = (channel, handler) => {
		const handlers = subscribers.get(channel) ?? [];
		handlers.push(handler);
		subscribers.set(channel, handlers);
		return () => {
			const current = subscribers.get(channel) ?? [];
			const index = current.indexOf(handler);
			if (index >= 0) current.splice(index, 1);
		};
	};
	const lifecycleEmit = pi.events.emit;
	pi.events.emit = (channel, data) => {
		lifecycleEmit(channel, data);
		for (const handler of subscribers.get(channel) ?? []) handler(data);
	};
	return pi;
}

function holdWorkflowMutex(pi, sessionManager) {
	let held = true;
	const unsubscribe = pi.events.on("workflow:mutex:v1", (payload) => {
		if (!held || payload?.session !== sessionManager || payload?.group !== "agent-workflow") return;
		payload.busy = true;
	});
	return {
		release() {
			held = false;
			unsubscribe();
		},
	};
}

function activeGoalContractEntry() {
	return {
		type: "custom",
		customType: "goal-contract",
		content: "Goal mode is active. Complete this goal fully.",
		details: { version: 2, state: "active", goalId: "goal-fixture" },
	};
}

function goalContinuationPrompt() {
	return "Continue the active /goal until it is complete.\n\n<!-- pi-goal-continuation:goal-fixture:0:test-marker -->";
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
		hasPendingMessages() {
			return false;
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
		continuationArtifactMode: "always",
		agentGuideSyncMode: "always",
	}), "utf8");
}

function writeArtifactOffConfig(cwd) {
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
		continuationArtifactMode: "off",
	}), "utf8");
}

function writePercentageConfig(cwd, percentage = 90, overrides = {}) {
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
		compactionThresholdMode: "percentage",
		compactionThresholdPercent: percentage,
		continuationArtifactMode: "off",
		showAfterCompact: false,
		...overrides,
	}), "utf8");
}

function writeNativeAdoptionConfig(cwd, overrides = {}) {
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
		adoptNativeCompaction: true,
		compactionThresholdMode: "reserve-tokens",
		continuationArtifactMode: "off",
		showAfterCompact: false,
		...overrides,
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

function compactableToolBranch() {
	return [
		branchMessageEntry("branch-user", null, userMessage(`run tool ${"x".repeat(80)}`)),
		branchAssistantToolEntry("branch-assistant", "branch-user", "tool-1", "/repo/file.ts"),
		branchToolResultEntry("branch-result", "branch-assistant", "tool-1", "x"),
	];
}

/** 20 轮工具批次，前 5 轮结果超大（可摇），后 15 轮结果极小（进保护区）。 */
function shakeableToolBranch() {
	const entries = [
		branchMessageEntry("shake-user", null, userMessage("run shake")),
	];
	for (let index = 1; index <= 20; index += 1) {
		const callId = `shake-call-${index}`;
		entries.push(branchMessageEntry(`shake-asst-${index}`, `shake-call-${index - 1}`, {
			...assistantMessage("toolUse"),
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "printf x" } }],
		}));
		entries.push(branchToolResultEntry(`shake-res-${index}`, `shake-asst-${index}`, callId, index <= 5 ? "y".repeat(60000) : "ok", "bash"));
	}
	return entries;
}

function compactionEvent(preparation = {}, branchEntries = [], overrides = {}) {
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
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		...overrides,
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

async function flushHostCompaction(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
	await flushHostCompaction();
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
	await flushHostCompaction();
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
	await flushHostCompaction();
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
	await pi.events.get("message_start")({ message: userMessage(CONTINUATION_PROMPT) }, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
	await pi.events.get("message_end")({ message: assistantMessage() }, ctx);
	assert.deepEqual(ctx.statusCalls, []);
	assert.equal(ctx.workingMessages.at(-1), undefined);
});

test("ordinary input remains non-destructive until its run boundary", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-input-boundary-window-"));
	try {
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
		await pi.events.get("input")({
			type: "input",
			text: "new user work",
			source: "interactive",
			streamingBehavior: "followUp",
		}, ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ordinary run boundaries supersede deferred resumes for direct and queued input", async () => {
	const cases = [
		{ delivery: "before", source: "interactive", streamingBehavior: undefined },
		{ delivery: "message", source: "interactive", streamingBehavior: "steer" },
		{ delivery: "message", source: "interactive", streamingBehavior: "followUp" },
	];
	for (const scenario of cases) {
		const cwd = mkdtempSync(join(tmpdir(), `pi-continue-boundary-${scenario.delivery}-`));
		try {
			const pi = createFakePi(cwd);
			const ctx = createCommandContext(cwd, async () => undefined);
			registerContinueExtension(pi);
			await pi.commands.get("continue").handler("steer", ctx);
			ctx.compactOptions.onComplete({});
			await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
			await pi.events.get("input")({
				type: "input",
				text: "new user work",
				source: scenario.source,
				streamingBehavior: scenario.streamingBehavior,
			}, ctx);
			if (scenario.delivery === "before") {
				await pi.events.get("before_agent_start")({ prompt: "new user work" }, ctx);
			} else {
				await pi.events.get("message_start")({ message: userMessage("new user work") }, ctx);
			}
			await flushHostCompaction();
			assert.deepEqual(pi.sent, []);
			assert.equal(pi.lifecycleEvents.some(([channel, data]) =>
				channel === "pi-continue:handoff-lifecycle" && data.phase === "failed" && data.eventId === "continue-1",
			), true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
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
		assert.equal(abortCount, 0);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("context guard owns one compaction across an above-native abort boundary", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-context-native-boundary-"));
	const faux = registerFauxProvider();
	try {
		writePercentageConfig(cwd, 90, { adoptNativeCompaction: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 25800, keepRecentTokens: 10 },
		}), "utf8");
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		const notifications = [];
		let abortCount = 0;
		ctx.model = { ...faux.models[0], contextWindow: 258000 };
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.getContextUsage = () => ({ tokens: 246577, percent: 95.57, contextWindow: 258000 });
		ctx.setBranch(compactableToolBranch());
		ctx.isIdle = () => false;
		ctx.abort = () => {
			abortCount += 1;
		};
		ctx.ui.notify = (message, type) => {
			notifications.push([message, type]);
		};
		registerContinueExtension(pi);
		const crossingAssistant = {
			...highUsageAssistantMessage(),
			usage: {
				input: 123268,
				output: 123269,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 246537,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const contextEvent = {
			messages: [userMessage("run tool"), crossingAssistant, toolResultMessage("x".repeat(160))],
		};
		await pi.events.get("context")(contextEvent, ctx);
		await pi.events.get("context")(contextEvent, ctx);
		assert.equal(ctx.compactCount, 0);
		assert.equal(abortCount, 1);

		const abortedError = {
			...assistantMessage("error"),
			content: [{ type: "toolCall", id: "partial-call", name: "bash", arguments: { command: "printf unsafe" } }],
			errorMessage: "This operation was aborted",
			usage: crossingAssistant.usage,
		};
		const replacement = await pi.events.get("message_end")({ message: abortedError }, ctx);
		assert.equal(replacement?.message.stopReason, "stop");
		assert.deepEqual(replacement?.message.content, []);
		assert.equal(replacement?.message.errorMessage, undefined);
		assert.deepEqual(pi.lifecycleEvents, [[
			"pi-continue:handoff-lifecycle",
			{ phase: "controlled-abort", eventId: "continue-1" },
		]]);
		await pi.events.get("turn_end")({ message: replacement.message, toolResults: [] }, ctx);
		assert.equal(replacement.message.stopReason, "stop");
		assert.equal(replacement.message.errorMessage, undefined);
		assert.equal(ctx.compactCount, 0);

		const result = await pi.events.get("session_before_compact")(
			compactionEvent({
				settings: { enabled: true, reserveTokens: 25800, keepRecentTokens: 10 },
			}, [], { reason: "manual", willRetry: false }),
			ctx,
		);
		assert.ok(result?.compaction);
		const savedEvent = {
			fromExtension: true,
			compactionEntry: {
				id: "compact-context-owned",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		};
		await pi.events.get("session_compact")(savedEvent, ctx);
		await pi.events.get("session_compact")(savedEvent, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
		assert.deepEqual(notifications.filter(([, type]) => type !== "info"), []);
		assert.equal(notifications.filter(([message]) => message.startsWith("automatic continuation: saving handoff")).length, 1);
		await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("mechanical shake returns a zero-LLM compaction and offloads originals", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-shake-integration-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-continue-shake-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 1000 };
		const entries = shakeableToolBranch();
		ctx.setBranch(entries);
		registerContinueExtension(pi);
		await pi.events.get("context")({
			messages: [
				userMessage("run shake"),
				{
					...assistantMessage("toolUse"),
					content: [{ type: "toolCall", id: "shake-call-1", name: "bash", arguments: { command: "printf y" } }],
				},
				toolResultMessage("y".repeat(60000), "shake-call-1"),
			],
		}, ctx);
		assert.equal(ctx.compactCount, 1);
		const result = await pi.events.get("session_before_compact")(compactionEvent({}, entries), ctx);
		assert.ok(result?.compaction);
		assert.match(result.compaction.summary, /mechanically shaken/);
		assert.match(result.compaction.summary, /retrieve with the read tool/);
		assert.equal(result.compaction.firstKeptEntryId, "shake-asst-6");
		assert.deepEqual(pi.sent, []);
		assert.equal(existsSync(join(agentDir, "offload", "index.jsonl")), true);
		const indexLines = readFileSync(join(agentDir, "offload", "index.jsonl"), "utf8").trim().split("\n");
		assert.equal(indexLines.length, 5);
		const first = JSON.parse(indexLines[0]);
		assert.equal(first.entryId, "shake-res-1");
		assert.equal(existsSync(first.path), true);
		// 摇树 handoff 的恢复使用简短引导词，不引用不存在的 LLM brief 结构。
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, [SHAKE_CONTINUATION_PROMPT]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("Goal-owned handoff keeps one pi-continue proof and one Goal resume", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-goal-coordination-"));
	const faux = registerFauxProvider();
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = enableWorkflowBus(createFakePi(cwd));
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 1000 };
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		const entries = [...compactableToolBranch(), activeGoalContractEntry()];
		ctx.setBranch(entries);
		registerContinueExtension(pi);
		await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const goalMutex = holdWorkflowMutex(pi, ctx.sessionManager);
		await pi.commands.get("continue").handler("steer", ctx);
		assert.equal(ctx.compactCount, 1);
		const preparation = compactionEvent({}, entries, { reason: "manual", willRetry: false });
		const before = await pi.events.get("session_before_compact")(preparation, ctx);
		assert.ok(before?.compaction);
		assert.equal(before.compaction.details.kind, "pi-continue/v4");
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-goal-coordination",
				summary: before.compaction.summary,
				details: before.compaction.details,
			},
		}, ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, []);
		const prompt = goalContinuationPrompt();
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		await pi.events.get("input")({ type: "input", text: prompt, source: "extension" }, ctx);
		await flushHostCompaction();
		await pi.events.get("before_agent_start")({ prompt }, ctx);
		assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
		assert.equal(ctx.workingMessages.at(-1), undefined);
		assert.deepEqual(pi.sent, [prompt]);
		goalMutex.release();
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Goal-owned compaction releases the host boundary before post-compaction I/O", async () => {
	for (const order of ["goal-first", "continue-first"]) {
		const cwd = mkdtempSync(join(tmpdir(), `pi-continue-goal-boundary-${order}-`));
		const faux = registerFauxProvider();
		try {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
				compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
			}), "utf8");
			mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({
				continuationArtifactMode: "always",
			}), "utf8");
			faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
			const pi = enableWorkflowBus(createFakePi(cwd));
			const ctx = createCommandContext(cwd, async () => undefined);
			ctx.model = { ...faux.models[0], contextWindow: 1000 };
			ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
			ctx.setBranch([...compactableToolBranch(), activeGoalContractEntry()]);
			registerContinueExtension(pi);
			await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
			const goalMutex = holdWorkflowMutex(pi, ctx.sessionManager);
			await pi.commands.get("continue").handler("steer", ctx);
			const before = await pi.events.get("session_before_compact")(compactionEvent({}, ctx.sessionManager.getBranch()), ctx);
			assert.ok(before?.compaction);
			ctx.compactOptions.onComplete({});

			let releaseProjectContext = () => {};
			let projectContextRequested = false;
			pi.exec = async (command, args, options) => {
				assert.equal(command, "git");
				assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
				projectContextRequested = true;
				await new Promise<void>((resolve) => {
					releaseProjectContext = resolve;
				});
				return { stdout: options?.cwd ?? cwd, code: 0 };
			};
			let compactionInProgress = true;
			let boundaryError;
			const originalSend = pi.sendUserMessage;
			pi.sendUserMessage = (prompt, options) => {
				if (compactionInProgress) throw new Error("Cannot submit a prompt while compaction is in progress.");
				originalSend(prompt, options);
			};
			const goalPrompt = goalContinuationPrompt();
			const dispatchGoalPrompt = () => {
				try {
					pi.sendUserMessage(goalPrompt, { deliverAs: "followUp" });
					void pi.events.get("input")({ type: "input", text: goalPrompt, source: "extension" }, ctx);
				} catch (error) {
					boundaryError = error;
				}
				setTimeout(() => releaseProjectContext(), 0);
			};
			const compactionEventResult = {
				fromExtension: true,
				compactionEntry: {
					id: "compact-goal-boundary",
					summary: before.compaction.summary,
					details: before.compaction.details,
				},
			};
			let compactPromise;
			if (order === "goal-first") {
				setTimeout(dispatchGoalPrompt, 0);
				compactPromise = pi.events.get("session_compact")(compactionEventResult, ctx);
			} else {
				compactPromise = pi.events.get("session_compact")(compactionEventResult, ctx);
				setTimeout(dispatchGoalPrompt, 0);
			}
			await compactPromise;
			assert.equal(projectContextRequested, false);
			compactionInProgress = false;
			for (let flush = 0; flush < 8; flush += 1) {
				if (projectContextRequested) releaseProjectContext();
				await flushHostCompaction();
			}
			assert.equal(boundaryError, undefined);
			assert.deepEqual(pi.sent, [goalPrompt]);
			assert.equal(existsSync(continuationArtifactPath(cwd)), true);
			await pi.events.get("before_agent_start")({ prompt: goalPrompt }, ctx);
			await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
			goalMutex.release();
		} finally {
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("a newer Goal iteration does not reuse a superseded pi-continue handoff", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-goal-iteration-race-"));
	const faux = registerFauxProvider();
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = enableWorkflowBus(createFakePi(cwd));
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 1000 };
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		const entries = [...compactableToolBranch(), activeGoalContractEntry()];
		ctx.setBranch(entries);
		registerContinueExtension(pi);
		await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const goalMutex = holdWorkflowMutex(pi, ctx.sessionManager);
		await pi.commands.get("continue").handler("steer", ctx);
		const before = await pi.events.get("session_before_compact")(compactionEvent({}, entries), ctx);
		assert.ok(before?.compaction);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-goal-iteration-race",
				summary: before.compaction.summary,
				details: before.compaction.details,
			},
		}, ctx);
		const ordinaryPrompt = "new user work";
		await pi.events.get("input")({ type: "input", text: ordinaryPrompt, source: "interactive" }, ctx);
		await pi.events.get("before_agent_start")({ prompt: ordinaryPrompt }, ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, []);
		const nextPrompt = goalContinuationPrompt().replace("goal-fixture:0:", "goal-fixture:1:");
		pi.sendUserMessage(nextPrompt, { deliverAs: "followUp" });
		await pi.events.get("input")({ type: "input", text: nextPrompt, source: "extension" }, ctx);
		await pi.events.get("before_agent_start")({ prompt: nextPrompt }, ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, [nextPrompt]);
		assert.equal(pi.sent.includes(CONTINUATION_PROMPT), false);
		assert.equal(pi.lifecycleEvents.filter(([channel, data]) =>
			channel === "pi-continue:handoff-lifecycle" && data.phase === "failed" && data.eventId === "continue-1",
		).length, 1);
		goalMutex.release();
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("same-run Goal compaction settles from the host turn without a duplicate Goal prompt", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-goal-same-run-"));
	const faux = registerFauxProvider();
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = enableWorkflowBus(createFakePi(cwd));
		const notifications = [];
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 1000 };
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.ui.notify = (message, type) => notifications.push([message, type]);
		const entries = [...compactableToolBranch(), activeGoalContractEntry()];
		ctx.setBranch(entries);
		registerContinueExtension(pi);
		await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const goalMutex = holdWorkflowMutex(pi, ctx.sessionManager);
		await pi.commands.get("continue").handler("steer", ctx);
		const before = await pi.events.get("session_before_compact")(compactionEvent({}, entries), ctx);
		assert.ok(before?.compaction);
		ctx.isIdle = () => false;
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-goal-same-run",
				summary: before.compaction.summary,
				details: before.compaction.details,
			},
		}, ctx);
		assert.deepEqual(pi.sent, []);
		await pi.events.get("context")({ messages: [userMessage("post-compaction context")] }, ctx);
		assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
		await pi.events.get("agent_end")({}, ctx);
		assert.deepEqual(pi.sent, []);
		assert.equal(ctx.workingMessages.at(-1), undefined);
		assert.equal(notifications.some(([, type]) => type === "error"), false);
		goalMutex.release();
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Goal-owned mechanical shake delegates the single resume to Goal", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-goal-shake-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-continue-goal-shake-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = enableWorkflowBus(createFakePi(cwd));
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 1000 };
		const entries = [...shakeableToolBranch(), activeGoalContractEntry()];
		ctx.setBranch(entries);
		registerContinueExtension(pi);
		await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const goalMutex = holdWorkflowMutex(pi, ctx.sessionManager);
		await pi.commands.get("continue").handler("steer", ctx);
		const before = await pi.events.get("session_before_compact")(compactionEvent({}, entries), ctx);
		assert.ok(before?.compaction);
		assert.match(before.compaction.summary, /mechanically shaken/);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-goal-shake",
				summary: before.compaction.summary,
				details: before.compaction.details,
			},
		}, ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, []);
		const prompt = goalContinuationPrompt();
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		await pi.events.get("input")({ type: "input", text: prompt, source: "extension" }, ctx);
		await flushHostCompaction();
		await pi.events.get("before_agent_start")({ prompt }, ctx);
		assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
		assert.deepEqual(pi.sent, [prompt]);
		goalMutex.release();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("Goal-owned native threshold compaction remains available when adoption is disabled", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-goal-native-fallback-"));
	try {
		writePercentageConfig(cwd, 90, { adoptNativeCompaction: false });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = enableWorkflowBus(createFakePi(cwd));
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		const entries = [...compactableToolBranch(), activeGoalContractEntry()];
		ctx.setBranch(entries);
		registerContinueExtension(pi);
		await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const goalMutex = holdWorkflowMutex(pi, ctx.sessionManager);
		const result = await pi.events.get("session_before_compact")(
			compactionEvent({}, entries, { reason: "threshold", willRetry: false }),
			ctx,
		);
		assert.equal(result, undefined);
		assert.equal(ctx.compactCount, 0);
		goalMutex.release();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Goal-owned synthesis failure yields to native compaction instead of cancelling it", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-goal-failure-"));
	const faux = registerFauxProvider();
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		faux.setResponses([fauxAssistantMessage("not-json")]);
		const pi = enableWorkflowBus(createFakePi(cwd));
		const notifications = [];
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 1000 };
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.ui.notify = (message, type) => notifications.push([message, type]);
		const entries = [...compactableToolBranch(), activeGoalContractEntry()];
		ctx.setBranch(entries);
		registerContinueExtension(pi);
		await pi.events.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
		const goalMutex = holdWorkflowMutex(pi, ctx.sessionManager);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent({}, entries), ctx);
		assert.equal(result, undefined);
		assert.equal(ctx.compactCount, 1);
		assert.equal(notifications.some(([message, type]) => type === "error" && message.includes("handoff failed")), false);
		const prompt = goalContinuationPrompt();
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		await pi.events.get("input")({ type: "input", text: prompt, source: "extension" }, ctx);
		assert.deepEqual(pi.sent, [prompt]);
		goalMutex.release();
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("failed controlled handoff publishes the matching lifecycle failure", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-controlled-abort-failure-"));
	try {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		ctx.setBranch(compactableToolBranch());
		registerContinueExtension(pi);
		await pi.events.get("context")({
			messages: [userMessage("run tool"), highUsageAssistantMessage(), toolResultMessage("x".repeat(160))],
		}, ctx);
		const replacement = await pi.events.get("message_end")({
			message: {
				...assistantMessage("error"),
				content: [],
				errorMessage: "This operation was aborted",
			},
		}, ctx);
		await pi.events.get("turn_end")({ message: replacement.message, toolResults: [] }, ctx);
		ctx.compactOptions.onError(new Error("compaction failed"));
		assert.deepEqual(pi.lifecycleEvents, [
			["pi-continue:handoff-lifecycle", { phase: "controlled-abort", eventId: "continue-1" }],
			["pi-continue:handoff-lifecycle", { phase: "failed", eventId: "continue-1" }],
		]);
		assert.deepEqual(pi.sent, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("native delegated handoff reports host compaction failure without sending resume", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-native-compaction-failure-"));
	try {
		writePercentageConfig(cwd, 90, { adoptNativeCompaction: false });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		ctx.setBranch(compactableToolBranch());
		ctx.isIdle = () => false;
		let abortCount = 0;
		ctx.abort = () => {
			abortCount += 1;
		};
		registerContinueExtension(pi);
		await pi.events.get("context")({
			messages: [userMessage("run tool"), highUsageAssistantMessage(), toolResultMessage("x".repeat(160))],
		}, ctx);
		assert.equal(ctx.compactCount, 0);
		assert.equal(abortCount, 1);
		const replacement = await pi.events.get("message_end")({
			message: {
				...assistantMessage("error"),
				content: [],
				errorMessage: "This operation was aborted",
			},
		}, ctx);
		assert.equal(replacement?.message.stopReason, "stop");
		await pi.events.get("session_compact_failed")({
			reason: "threshold",
			aborted: true,
		}, ctx);
		assert.deepEqual(pi.lifecycleEvents, [
			["pi-continue:handoff-lifecycle", { phase: "controlled-abort", eventId: "continue-1" }],
			["pi-continue:handoff-lifecycle", { phase: "failed", eventId: "continue-1" }],
		]);
		assert.deepEqual(pi.sent, []);
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
		assert.equal(abortCount, 0);
		assert.equal(notifications.length, 2);
		assert.match(notifications[1][0], /^automatic continuation: saving handoff/);
		assert.equal(notifications[1][1], "info");
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent(), ctx);
		await flushHostCompaction();
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
			compactionThresholdMode: "reserve-tokens",
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
		await flushHostCompaction();
		await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
		await pi.events.get("message_end")({ message: highUsageAssistantMessage() }, ctx);
		assert.equal(ctx.workingMessages.at(-1), "pi-continue resume running");
		await pi.events.get("context")({
			messages: [userMessage("continue tools"), highUsageAssistantMessage(), toolResultMessage("x".repeat(160))],
		}, ctx);
		assert.equal(ctx.compactCount, 2);
		assert.equal(abortCount, 0);
		assert.equal(ctx.workingMessages.at(-1), "pi-continue saving handoff");
		assert.deepEqual(notifications, [
			["/continue steer: saving handoff.", "info"],
			["/continue steer: resume request sent.", "info"],
			["automatic continuation: saving handoff (130/100 tokens, threshold 80).", "info"],
		]);
		ctx.compactOptions.onComplete({});
		await pi.events.get("session_compact")(ownedCompactionEvent("continue-2"), ctx);
		await flushHostCompaction();
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

test("settings dialog stores percentage thresholds without rewriting Pi reserve tokens", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-percentage-settings-"));
	try {
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
				if (settingsSelectCount === 1) {
					const modeOption = options.find((option) => option.startsWith("Compaction threshold mode:"));
					assert.equal(modeOption, "Compaction threshold mode: Fixed reserve tokens");
					return modeOption;
				}
				if (settingsSelectCount === 2) {
					const triggerOption = options.find((option) => option.startsWith("Handoff trigger:"));
					assert.equal(triggerOption, "Handoff trigger: 90% (115,200 tokens for this model)");
					return triggerOption;
				}
				return "Done";
			}
			if (title === "Compaction threshold mode") {
				assert.deepEqual(options, ["Fixed reserve tokens", "Percentage of current model"]);
				return "Percentage of current model";
			}
			if (title === "Handoff trigger") {
				assert.deepEqual(options, ["Keep current (90%)", "Set context percentage"]);
				return "Set context percentage";
			}
			return undefined;
		};
		ctx.ui.input = async (title, placeholder) => {
			assert.equal(title, "Handoff trigger");
			assert.equal(placeholder, "percentage above 0 and below 100, for example 90");
			return "92.5%";
		};
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("settings project", ctx);
		const config = JSON.parse(readFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), "utf8"));
		assert.deepEqual(config, {
			compactionThresholdMode: "percentage",
			compactionThresholdPercent: 92.5,
		});
		assert.equal(existsSync(join(cwd, ".pi", "settings.json")), false);
		assert.deepEqual(notifications, [["Updated project handoff trigger", "info"]]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("settings dialog toggles the post-compaction brief panel", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-display-settings-"));
	try {
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		let settingsSelectCount = 0;
		ctx.ui.select = async (title, options) => {
			if (title !== "Continuation settings") return undefined;
			settingsSelectCount += 1;
			const displayOption = options.find((option) => option.startsWith("Show brief after compaction:"));
			if (settingsSelectCount === 1) {
				assert.equal(displayOption, "Show brief after compaction: no");
				return displayOption;
			}
			assert.equal(displayOption, "Show brief after compaction: yes");
			return "Done";
		};
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("settings project", ctx);
		const config = JSON.parse(readFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), "utf8"));
		assert.deepEqual(config, { showAfterCompact: true });
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
	await flushHostCompaction();
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
	await flushHostCompaction();
	await abortedPi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, abortedCtx);
	await abortedPi.events.get("message_end")({ message: assistantMessage("aborted") }, abortedCtx);
	assert.deepEqual(abortedCtx.statusCalls, []);
	assert.equal(abortedCtx.workingMessages.at(-1), undefined);
});

test("session_compact native or invalid active handoff proof fails closed without resume", async () => {
	const cwd = process.cwd();
	const nativePi = enableWorkflowBus(createFakePi(cwd));
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
	const nativeReplacement = new WorkflowCoordination(nativePi);
	assert.equal(nativeReplacement.claimEvent(nativeCtx, "native-replacement", []), "self");

	const invalidPi = enableWorkflowBus(createFakePi(cwd));
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
	await flushHostCompaction();
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
		await flushHostCompaction();
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
	await flushHostCompaction();
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
	assert.deepEqual(pi.sent, []);
	await flushHostCompaction();
	assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
});

test("session_compact keeps the ledger panel closed when post-compaction display is disabled", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-display-off-"));
	try {
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({ showAfterCompact: false }), "utf8");
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
		assert.equal(customCalls, 0);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		await pi.commands.get("continue").handler("ledger", ctx);
		assert.equal(customCalls, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_compact opens the ledger panel after explicit opt-in", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-display-on-"));
	try {
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "pi-continue.json"), JSON.stringify({ showAfterCompact: true }), "utf8");
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
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("percentage threshold starts one owned compaction when it is earlier than Pi native threshold", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-percentage-early-"));
	try {
		writePercentageConfig(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 5, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		ctx.getContextUsage = () => ({ tokens: 90, percent: 90, contextWindow: 100 });
		ctx.setBranch(compactableToolBranch());
		registerContinueExtension(pi);
		await pi.events.get("turn_end")({ message: assistantMessage("stop"), toolResults: [] }, ctx);
		await pi.events.get("turn_end")({ message: assistantMessage("stop"), toolResults: [] }, ctx);
		assert.equal(ctx.compactCount, 1);
		assert.match(ctx.compactOptions.customInstructions, /Compaction threshold: 90% \(90 of 100 tokens\)\./);
		ctx.compactOptions.onError(new Error("test settlement"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("percentage threshold exact match starts at an equal Pi token boundary", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-percentage-equal-"));
	try {
		writePercentageConfig(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		ctx.getContextUsage = () => ({ tokens: 90, percent: 90, contextWindow: 100 });
		ctx.setBranch(compactableToolBranch());
		registerContinueExtension(pi);
		await pi.events.get("turn_end")({ message: assistantMessage("stop"), toolResults: [] }, ctx);
		assert.equal(ctx.compactCount, 1);
		ctx.compactOptions.onError(new Error("test settlement"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("percentage threshold yields to one Pi native compaction after crossing the strict native boundary", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-percentage-native-"));
	const faux = registerFauxProvider();
	try {
		writePercentageConfig(cwd, 90, { adoptNativeCompaction: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 5, keepRecentTokens: 10 },
		}), "utf8");
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 100 };
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.getContextUsage = () => ({ tokens: 96, percent: 96, contextWindow: 100 });
		ctx.isIdle = () => false;
		ctx.setBranch(compactableToolBranch());
		registerContinueExtension(pi);
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
		await pi.events.get("turn_end")({ message: assistantMessage("stop"), toolResults: [] }, ctx);
		assert.equal(ctx.compactCount, 0);
		assert.equal(ctx.compactOptions, undefined);
		const result = await pi.events.get("session_before_compact")(
			compactionEvent({
				settings: { enabled: true, reserveTokens: 5, keepRecentTokens: 10 },
			}, [], { reason: "threshold", willRetry: false }),
			ctx,
		);
		assert.ok(result?.compaction);
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		const savedEvent = {
			fromExtension: true,
			compactionEntry: {
				id: "compact-native-percentage",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		};
		await pi.events.get("session_compact")(savedEvent, ctx);
		await pi.events.get("session_compact")(savedEvent, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
		await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("percentage compaction proof wins when a native compaction finishes before the delayed manual callback", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-percentage-race-"));
	const faux = registerFauxProvider();
	try {
		writePercentageConfig(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 5, keepRecentTokens: 10 },
		}), "utf8");
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...faux.models[0], contextWindow: 100 };
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		let contextTokens = 90;
		ctx.getContextUsage = () => ({ tokens: contextTokens, percent: contextTokens, contextWindow: 100 });
		ctx.isIdle = () => false;
		ctx.setBranch(compactableToolBranch());
		registerContinueExtension(pi);
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
		await pi.events.get("turn_end")({ message: assistantMessage("stop"), toolResults: [] }, ctx);
		assert.equal(ctx.compactCount, 1);
		contextTokens = 96;
		const result = await pi.events.get("session_before_compact")(
			compactionEvent({
				settings: { enabled: true, reserveTokens: 5, keepRecentTokens: 10 },
			}, [], { reason: "threshold", willRetry: false }),
			ctx,
		);
		assert.ok(result?.compaction);
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-native-won-race",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		}, ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		ctx.compactOptions.onError(new Error("Already compacted"));
		ctx.compactOptions.onError(new Error("Already compacted"));
		assert.equal(ctx.compactCount, 1);
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
		await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("percentage threshold defers only early native threshold compaction and fails open on unknown usage", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-percentage-late-"));
	try {
		writePercentageConfig(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 10 },
		}), "utf8");
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = { ...ctx.model, contextWindow: 100 };
		ctx.getContextUsage = () => ({ tokens: 85, percent: 85, contextWindow: 100 });
		registerContinueExtension(pi);
		await pi.events.get("turn_end")({ message: assistantMessage("stop"), toolResults: [] }, ctx);
		assert.equal(ctx.compactCount, 0);
		const thresholdEvent = compactionEvent({}, [], { reason: "threshold", willRetry: false });
		assert.deepEqual(await pi.events.get("session_before_compact")(thresholdEvent, ctx), { cancel: true });
		assert.equal(await pi.events.get("session_before_compact")(compactionEvent({}, [], { reason: "manual" }), ctx), undefined);
		assert.equal(await pi.events.get("session_before_compact")(compactionEvent({}, [], { reason: "overflow", willRetry: true }), ctx), undefined);
		ctx.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 100 });
		await pi.events.get("turn_end")({ message: assistantMessage("stop"), toolResults: [] }, ctx);
		assert.equal(ctx.compactCount, 0);
		assert.equal(await pi.events.get("session_before_compact")(thresholdEvent, ctx), undefined);
		ctx.getContextUsage = () => ({ tokens: 90, percent: 90, contextWindow: 100 });
		assert.equal(await pi.events.get("session_before_compact")(thresholdEvent, ctx), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("native threshold adoption synthesizes one owned handoff and dispatches one resume", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-native-adoption-"));
	const faux = registerFauxProvider();
	try {
		writeNativeAdoptionConfig(cwd);
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.isIdle = () => false;
		let abortCount = 0;
		ctx.abort = () => {
			abortCount += 1;
		};
		registerContinueExtension(pi);
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
		const thresholdEvent = compactionEvent({}, [], { reason: "threshold", willRetry: false });
		const result = await pi.events.get("session_before_compact")(thresholdEvent, ctx);
		assert.ok(result?.compaction);
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		assert.equal(ctx.compactCount, 0);
		assert.equal(abortCount, 0);
		const duplicate = await pi.events.get("session_before_compact")(thresholdEvent, ctx);
		assert.deepEqual(duplicate, { cancel: true });
		const savedEvent = {
			fromExtension: true,
			compactionEntry: {
				id: "compact-adopted",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		};
		await pi.events.get("session_compact")(savedEvent, ctx);
		await pi.events.get("session_compact")(savedEvent, ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
		await pi.events.get("before_agent_start")({ prompt: CONTINUATION_PROMPT }, ctx);
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("native threshold adoption accepts a complete tool-result batch boundary", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-native-tool-batch-"));
	const faux = registerFauxProvider();
	try {
		writeNativeAdoptionConfig(cwd);
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.isIdle = () => false;
		registerContinueExtension(pi);
		const toolUseMessage = {
			...assistantMessage("toolUse"),
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf x" } }],
		};
		await pi.events.get("message_end")({ message: toolUseMessage }, ctx);
		await pi.events.get("turn_end")({
			message: toolUseMessage,
			toolResults: [toolResultMessage("tool output", "tool-1")],
		}, ctx);
		const result = await pi.events.get("session_before_compact")(
			compactionEvent({}, [], { reason: "threshold", willRetry: false }),
			ctx,
		);
		assert.ok(result?.compaction);
		assert.equal(result.compaction.details.continuationEventId, "continue-1");
		assert.equal(ctx.compactCount, 0);
		await pi.events.get("session_compact")({
			fromExtension: true,
			compactionEntry: {
				id: "compact-tool-batch",
				summary: result.compaction.summary,
				details: result.compaction.details,
			},
		}, ctx);
		await flushHostCompaction();
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
		assert.deepEqual(pi.sentOptions, [{ deliverAs: "followUp" }]);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("failed native threshold adoption releases ownership to Pi native compaction", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-native-fallback-"));
	const faux = registerFauxProvider();
	try {
		writeNativeAdoptionConfig(cwd, { synthesisTimeoutMs: 600000 });
		faux.setResponses([fauxAssistantMessage("not json")]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		ctx.isIdle = () => false;
		registerContinueExtension(pi);
		await pi.events.get("message_end")({ message: assistantMessage("stop") }, ctx);
		const result = await pi.events.get("session_before_compact")(
			compactionEvent({}, [], { reason: "threshold", willRetry: false }),
			ctx,
		);
		assert.equal(result, undefined);
		assert.equal(ctx.compactCount, 0);
		assertNoFailedSynthesisSideEffects(cwd, pi);
		await pi.events.get("session_compact")({
			fromExtension: false,
			compactionEntry: { id: "compact-native", summary: "native", details: undefined },
		}, ctx);
		assert.deepEqual(pi.sent, []);
		await pi.commands.get("continue").handler("steer", ctx);
		assert.equal(ctx.compactCount, 1);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact and session_compact write default artifact and configured agent guide only after a successful compaction", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-sync-success-"));
	const faux = registerFauxProvider();
	try {
		writeAgentGuideSyncConfig(cwd);
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson("# Agent Guide\n\nDurable rule.\n"))]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
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
		await flushHostCompaction();
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact summarizes provider-unsafe kept suffixes before returning compaction proof", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-provider-safe-"));
	const faux = registerFauxProvider();
	try {
		let observedPrompt = "";
		faux.setResponses([((context) => {
			observedPrompt = JSON.stringify(context);
			return fauxAssistantMessage(continuationArtifactJson());
		})]);
		const pi = createFakePi(cwd);
		const notifications = [];
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.ui.notify = (message, type) => {
			notifications.push([message, type]);
		};
		ctx.model = faux.models[0];
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
		assert.deepEqual(notifications, [
			["/continue steer: saving handoff.", "info"],
			["pi-continue adjusted the handoff boundary to preserve provider message ordering.", "info"],
		]);
		assert.deepEqual(pi.sent, []);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact omits stale continuation docs and prior artifacts from provider prompt", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-no-stale-input-"));
	const faux = registerFauxProvider();
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
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("continuationArtifactMode off suppresses successful artifact writes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-artifact-off-"));
	const faux = registerFauxProvider();
	try {
		writeArtifactOffConfig(cwd);
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson())]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
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
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("session_before_compact clamps history output budget to model max tokens", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-output-clamp-"));
	const faux = registerFauxProvider({ models: [{ id: "small-output", reasoning: false, maxTokens: 256 }] });
	try {
		let observedMaxTokens;
		faux.setResponses([(_context, options) => {
			observedMaxTokens = options?.maxTokens;
			return fauxAssistantMessage(continuationArtifactJson());
		}]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
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
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact cancels instead of returning ownerless details when ownership is lost during synthesis", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-owner-lost-"));
	const faux = registerFauxProvider();
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
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact does not attribute an old synthesis to a newer continuation owner", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-owner-replaced-"));
	const faux = registerFauxProvider();
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
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("late compaction for abandoned owner does not fail a newer active handoff", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-late-abandoned-owner-"));
	const faux = registerFauxProvider();
	try {
		writeAgentGuideSyncConfig(cwd);
		faux.setResponses([fauxAssistantMessage(continuationArtifactJson("# Agent Guide\n\nOld abandoned guide.\n"))]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
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
		await flushHostCompaction();
		assert.deepEqual(pi.sent, [CONTINUATION_PROMPT]);
	} finally {
		faux.unregister();
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
	const faux = registerFauxProvider();
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
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const startedAt = Date.now();
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		assert.ok(Date.now() - startedAt < 1000);
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("session_before_compact fails closed when history artifacts are malformed", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-continue-hard-fail-"));
	const faux = registerFauxProvider();
	try {
		writeAgentGuideSyncConfig(cwd);
		faux.setResponses([fauxAssistantMessage("not json")]);
		const pi = createFakePi(cwd);
		const ctx = createCommandContext(cwd, async () => undefined);
		ctx.model = faux.models[0];
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		faux.unregister();
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
	const faux = registerFauxProvider();
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
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test", headers: {} });
		registerContinueExtension(pi);
		await pi.commands.get("continue").handler("steer", ctx);
		const result = await pi.events.get("session_before_compact")(compactionEvent(), ctx);
		assert.deepEqual(result, { cancel: true });
		assertNoFailedSynthesisSideEffects(cwd, pi);
	} finally {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});
