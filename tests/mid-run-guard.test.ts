import test from "node:test";
import assert from "node:assert/strict";
import {
	decideMidRunGuardTrigger,
	hasNativeCompactionPreparation,
	shouldEvaluateMidRunContext,
} from "../extensions/continue/src/mid-run-guard.ts";

function config(overrides = {}) {
	return {
		enabled: true,
		summarizerModel: "inherit",
		reasoning: "inherit",
		historyMaxTokens: null,
		continuationArtifactMode: "always",
		agentGuidePath: "AGENTS.md",
		agentGuideSyncMode: "off",
		midRunGuardEnabled: true,
		appendCompactionMetadata: true,
		appendReadFileTags: false,
		appendModifiedFileTags: true,
		promptOverridePolicy: "project-override",
		showAfterCompact: true,
		...overrides,
	};
}

function input(overrides = {}) {
	return {
		config: config(),
		piSettings: {
			enabled: true,
			reserveTokens: 20,
			keepRecentTokens: 10,
		},
		contextWindow: 100,
		estimate: {
			tokens: 81,
			usageTokens: 70,
			trailingTokens: 11,
			lastUsageIndex: 3,
		},
		...overrides,
	};
}

function userMessage() {
	return { role: "user" };
}

function assistantMessage(...toolCallIds: string[]) {
	return {
		role: "assistant",
		content: toolCallIds.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: `/repo/${id}.ts` } })),
	};
}

function assistantTextMessage() {
	return { role: "assistant", content: [{ type: "text", text: "done" }] };
}

function toolResultMessage(toolCallId: string) {
	return { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: "file" }], isError: false };
}

function branchMessageEntry(id: string, parentId: string | null, message: unknown) {
	return { type: "message", id, parentId, timestamp: "2026-07-08T12:00:00.000Z", message };
}

function repairableToolBranch() {
	return [
		branchMessageEntry("user", null, userMessage()),
		branchMessageEntry("assistant", "user", assistantMessage("call-a")),
		branchMessageEntry("result", "assistant", toolResultMessage("call-a")),
	];
}

function fileOps() {
	return { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
}

function nativePreparation(overrides = {}) {
	const settings = { enabled: true, reserveTokens: 20, keepRecentTokens: 10 };
	return {
		firstKeptEntryId: "user",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 0,
		fileOps: fileOps(),
		settings,
		...overrides,
	};
}

test("shouldEvaluateMidRunContext only accepts contexts ending in a complete assistant/tool-result batch", () => {
	assert.equal(shouldEvaluateMidRunContext([{ role: "user" }]), false);
	assert.equal(shouldEvaluateMidRunContext([userMessage(), assistantMessage("call-a")]), false);
	assert.equal(shouldEvaluateMidRunContext([userMessage(), assistantMessage("call-a"), toolResultMessage("call-a")]), true);
	assert.equal(shouldEvaluateMidRunContext([userMessage(), assistantMessage("call-a", "call-b"), toolResultMessage("call-a"), toolResultMessage("call-b")]), true);
	assert.equal(shouldEvaluateMidRunContext([userMessage(), assistantMessage("call-a"), toolResultMessage("call-a"), userMessage()]), false);
	assert.equal(shouldEvaluateMidRunContext([assistantMessage("call-a"), toolResultMessage("call-a"), assistantTextMessage()]), false);
	assert.equal(shouldEvaluateMidRunContext([assistantMessage("call-a"), userMessage(), toolResultMessage("call-a")]), false);
	assert.equal(shouldEvaluateMidRunContext([userMessage(), assistantTextMessage(), toolResultMessage("orphan")]), false);
	assert.equal(shouldEvaluateMidRunContext([userMessage(), assistantMessage("call-a"), toolResultMessage("call-b")]), false);
	assert.equal(shouldEvaluateMidRunContext([userMessage(), assistantMessage("call-a", "call-b"), toolResultMessage("call-a")]), false);
	assert.equal(shouldEvaluateMidRunContext([userMessage(), assistantMessage("call-a"), toolResultMessage("call-a"), toolResultMessage("extra")]), false);
});

test("decideMidRunGuardTrigger ignores disabled branches", () => {
	assert.equal(decideMidRunGuardTrigger(input({ config: config({ enabled: false }) })), undefined);
	assert.equal(decideMidRunGuardTrigger(input({ config: config({ midRunGuardEnabled: false }) })), undefined);
	assert.equal(decideMidRunGuardTrigger(input({ piSettings: { enabled: false, reserveTokens: 20, keepRecentTokens: 10 } })), undefined);
	assert.equal(decideMidRunGuardTrigger(input({ contextWindow: undefined })), undefined);
});

test("decideMidRunGuardTrigger only trips above the reserve threshold", () => {
	assert.equal(decideMidRunGuardTrigger(input({ estimate: { tokens: 80, usageTokens: 70, trailingTokens: 10, lastUsageIndex: 3 } })), undefined);
	assert.deepEqual(decideMidRunGuardTrigger(input()), {
		estimatedTokens: 81,
		thresholdTokens: 80,
		contextWindow: 100,
		reserveTokens: 20,
		usageTokens: 70,
		trailingTokens: 11,
		lastUsageIndex: 3,
	});
});

test("hasNativeCompactionPreparation rejects Pi's false no-preparation sentinel", () => {
	const branchEntries = [{ type: "message", id: "user", message: { role: "user", content: [{ type: "text", text: "large" }] } }];
	const piSettings = { enabled: true, reserveTokens: 20, keepRecentTokens: 10 };
	assert.equal(hasNativeCompactionPreparation(false, branchEntries, piSettings, () => 1000), false);
	assert.equal(hasNativeCompactionPreparation(undefined, branchEntries, piSettings, () => 1000), false);
});

test("hasNativeCompactionPreparation rejects malformed object-shaped preparations", () => {
	const branchEntries = repairableToolBranch();
	const piSettings = { enabled: true, reserveTokens: 20, keepRecentTokens: 10 };
	const malformedPreparations = [
		{},
		{ firstKeptEntryId: "user", messagesToSummarize: [], turnPrefixMessages: [] },
		{ ...nativePreparation(), fileOps: { read: {}, written: {}, edited: {} } },
		{ ...nativePreparation(), settings: { reserveTokens: 20, keepRecentTokens: 10 } },
	];
	for (const preparation of malformedPreparations) {
		assert.doesNotThrow(() => hasNativeCompactionPreparation(preparation, branchEntries, piSettings, () => 1000));
		assert.equal(hasNativeCompactionPreparation(preparation, branchEntries, piSettings, () => 1000), false);
	}
});

test("hasNativeCompactionPreparation accepts non-empty native preparations", () => {
	const piSettings = { enabled: true, reserveTokens: 20, keepRecentTokens: 10 };
	assert.equal(hasNativeCompactionPreparation(
		nativePreparation({ messagesToSummarize: [userMessage()] }),
		[],
		piSettings,
		() => 0,
	), true);
	assert.equal(hasNativeCompactionPreparation(
		nativePreparation({ turnPrefixMessages: [userMessage()] }),
		[],
		piSettings,
		() => 0,
	), true);
});

test("hasNativeCompactionPreparation classifies object-shaped no-op preparations", () => {
	const repairableBranch = repairableToolBranch();
	const piSettings = { enabled: true, reserveTokens: 20, keepRecentTokens: 10 };
	assert.equal(hasNativeCompactionPreparation(
		nativePreparation({ settings: { ...piSettings, keepRecentTokens: 4000 } }),
		repairableBranch,
		{ ...piSettings, keepRecentTokens: 4000 },
		() => 1000,
	), false);
	assert.equal(hasNativeCompactionPreparation(
		nativePreparation(),
		repairableBranch,
		piSettings,
		() => 1000,
	), true);
	assert.equal(hasNativeCompactionPreparation(
		nativePreparation(),
		[branchMessageEntry("user", null, userMessage())],
		piSettings,
		() => 1000,
	), false);
	assert.equal(hasNativeCompactionPreparation(
		nativePreparation({ firstKeptEntryId: "assistant" }),
		repairableBranch,
		piSettings,
		() => 1000,
	), false);
});
