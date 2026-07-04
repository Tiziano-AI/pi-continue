import test from "node:test";
import assert from "node:assert/strict";
import { buildLedgerSnapshot, createContinuationLedgerOverlayController, ContinuationLedgerOverlay, extractContinuationLedger, showLatestContinuationLedger } from "../extensions/continue/src/ledger-viewer.ts";

const theme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

test("extractContinuationLedger reads only the continuation block", () => {
	const summary = [
		"<continuation>",
		"## Task",
		"finish runtime proof",
		"</continuation>",
	].join("\n");
	assert.equal(extractContinuationLedger(summary), "## Task\nfinish runtime proof");
});

test("buildLedgerSnapshot stores transient overlay content without session mutation fields", () => {
	const snapshot = buildLedgerSnapshot("<continuation>\nledger body\n</continuation>", "continue-1", "compact-1");
	assert.ok(snapshot);
	assert.equal(snapshot.eventId, "continue-1");
	assert.equal(snapshot.compactionEntryId, "compact-1");
	assert.equal(snapshot.content, "ledger body");
	assert.equal(Object.hasOwn(snapshot, "message"), false);
	assert.equal(Object.hasOwn(snapshot, "display"), false);
});

test("buildLedgerSnapshot strips terminal control sequences from untrusted content", () => {
	const snapshot = buildLedgerSnapshot(
		"<continuation>\n\u001b]2;secret title\u0007\u001b[31mred\u001b[0m\r\nline\u0000two\n</continuation>",
		"continue-1",
		"compact-1",
	);
	assert.ok(snapshot);
	assert.equal(snapshot.content, "red\nlinetwo");
	assert.doesNotMatch(snapshot.content, /\u001b|\u0007|\u0000/);
});

test("Continuation Ledger overlay controller reports unsupported custom UI", async () => {
	let factoryInvoked = false;
	const overlay = createContinuationLedgerOverlayController();
	const shown = await overlay.show(
		{
			hasUI: true,
			ui: {
				async custom(factory) {
					factoryInvoked = false;
					return undefined;
				},
			},
		},
		{ eventId: "continue-1", compactionEntryId: "compact-1", content: "ledger", capturedAt: 0 },
	);
	assert.equal(factoryInvoked, false);
	assert.equal(shown, false);
});

test("Continuation Ledger overlay controller reports supported custom UI", async () => {
	let factoryInvoked = false;
	const overlay = createContinuationLedgerOverlayController();
	const shown = await overlay.show(
		{
			hasUI: true,
			ui: {
				async custom(factory) {
					factoryInvoked = true;
					factory({ requestRender() {} }, theme, {}, () => {});
					return undefined;
				},
			},
		},
		{ eventId: "continue-1", compactionEntryId: "compact-1", content: "ledger", capturedAt: 0 },
	);
	overlay.clear();
	assert.equal(factoryInvoked, true);
	assert.equal(shown, true);
});

test("Continuation Ledger overlay controller updates and focuses the active singleton", async () => {
	let customCalls = 0;
	let focusCalls = 0;
	let requestRenders = 0;
	let hidden = false;
	let resolveOverlay;
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory, options) {
				customCalls += 1;
				factory(
					{ requestRender() { requestRenders += 1; } },
					theme,
					{},
					() => {},
				);
				options.onHandle({
					focus() { focusCalls += 1; },
					hide() {
						hidden = true;
						resolveOverlay?.();
					},
				});
				return new Promise((resolve) => {
					resolveOverlay = resolve;
				});
			},
		},
	};
	const overlay = createContinuationLedgerOverlayController();
	const first = overlay.show(ctx, { eventId: "continue-1", compactionEntryId: "compact-1", content: "first", capturedAt: 0 });
	await Promise.resolve();
	assert.equal(await overlay.show(ctx, { eventId: "continue-2", compactionEntryId: "compact-2", content: "second", capturedAt: 1 }), true);
	assert.equal(customCalls, 1);
	assert.equal(focusCalls, 1);
	assert.equal(requestRenders, 1);
	overlay.clear();
	assert.equal(hidden, true);
	resolveOverlay?.();
	assert.equal(await first, true);
});

test("Continuation Ledger overlay controller keeps reuse scoped per controller", async () => {
	let firstCustomCalls = 0;
	let secondCustomCalls = 0;
	let firstFocusCalls = 0;
	let secondFocusCalls = 0;
	function createCtx(onCustom, onFocus) {
		return {
			hasUI: true,
			ui: {
				custom(factory, options) {
					onCustom();
					factory({ requestRender() {} }, theme, {}, () => {});
					options.onHandle({ focus: onFocus, hide() {} });
					return new Promise(() => {});
				},
			},
		};
	}
	const firstOverlay = createContinuationLedgerOverlayController();
	const secondOverlay = createContinuationLedgerOverlayController();
	const firstCtx = createCtx(() => { firstCustomCalls += 1; }, () => { firstFocusCalls += 1; });
	const secondCtx = createCtx(() => { secondCustomCalls += 1; }, () => { secondFocusCalls += 1; });
	await firstOverlay.show(firstCtx, { eventId: "continue-1", compactionEntryId: "compact-1", content: "first", capturedAt: 0 });
	await secondOverlay.show(secondCtx, { eventId: "continue-2", compactionEntryId: "compact-2", content: "second", capturedAt: 1 });
	await firstOverlay.show(firstCtx, { eventId: "continue-3", compactionEntryId: "compact-3", content: "third", capturedAt: 2 });
	assert.equal(firstCustomCalls, 1);
	assert.equal(secondCustomCalls, 1);
	assert.equal(firstFocusCalls, 1);
	assert.equal(secondFocusCalls, 0);
	firstOverlay.clear();
	secondOverlay.clear();
});

test("Continuation Ledger overlay controller focuses after delayed handle delivery", async () => {
	let focusCalls = 0;
	let requestRenders = 0;
	let onHandle;
	const ctx = {
		hasUI: true,
		ui: {
			custom(factory, options) {
				factory({ requestRender() { requestRenders += 1; } }, theme, {}, () => {});
				onHandle = options.onHandle;
				return new Promise(() => {});
			},
		},
	};
	const overlay = createContinuationLedgerOverlayController();
	await overlay.show(ctx, { eventId: "continue-1", compactionEntryId: "compact-1", content: "first", capturedAt: 0 });
	await overlay.show(ctx, { eventId: "continue-2", compactionEntryId: "compact-2", content: "second", capturedAt: 1 });
	onHandle({ focus() { focusCalls += 1; }, hide() {} });
	assert.equal(focusCalls, 1);
	assert.equal(requestRenders, 1);
	overlay.clear();
});

test("showLatestContinuationLedger uses transient UI without session transcript mutation", async () => {
	let customCalls = 0;
	const forbiddenTranscriptSurface = new Proxy({}, {
		get(_target, property) {
			throw new Error(`unexpected transcript access: ${String(property)}`);
		},
	});
	const ctx = {
		hasUI: true,
		sessionManager: forbiddenTranscriptSurface,
		ui: {
			custom(factory) {
				customCalls += 1;
				factory({ requestRender() {} }, theme, {}, () => {});
				return Promise.resolve();
			},
			notify() {},
		},
	};
	const overlay = createContinuationLedgerOverlayController();
	await showLatestContinuationLedger(ctx, { eventId: "continue-1", compactionEntryId: "compact-1", content: "ledger", capturedAt: 0 }, overlay);
	assert.equal(customCalls, 1);
	overlay.clear();
});

test("Continuation Ledger overlay fire-and-forget display reports open failures", async () => {
	const reasons: string[] = [];
	const overlay = createContinuationLedgerOverlayController();
	overlay.showSoon(
		{
			hasUI: true,
			ui: {
				custom(factory) {
					factory({ requestRender() {} }, theme, {}, () => {});
					return Promise.reject(new Error("open failed"));
				},
			},
		},
		{ eventId: "continue-1", compactionEntryId: "compact-1", content: "ledger", capturedAt: 0 },
		(reason) => reasons.push(reason),
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(reasons, ["Continuation Ledger could not open."]);
});

test("ContinuationLedgerOverlay renders scrollable ledger panel", () => {
	let closed = false;
	let renders = 0;
	const overlay = new ContinuationLedgerOverlay(
		{ eventId: "continue-1", compactionEntryId: "compact-1", content: "line 1\nline 2", capturedAt: 0 },
		theme,
		() => {
			closed = true;
		},
		() => {
			renders += 1;
		},
	);
	const text = overlay.render(80).join("\n");
	assert.match(text, /Continuation Ledger/);
	assert.match(text, /run continue-1 \| compaction compact-1/);
	assert.match(text, /line 1/);
	overlay.handleInput("down");
	overlay.handleInput("q");
	assert.equal(closed, true);
	assert.equal(renders, 0);
});

test("ContinuationLedgerOverlay updates content in place and resets scroll", () => {
	let renders = 0;
	const overlay = new ContinuationLedgerOverlay(
		{ eventId: "continue-1", compactionEntryId: "compact-1", content: Array.from({ length: 40 }, (_entry, index) => `old ${index + 1}`).join("\n"), capturedAt: 0 },
		theme,
		() => {},
		() => {
			renders += 1;
		},
	);
	overlay.focused = true;
	overlay.handleInput("down");
	assert.match(overlay.render(80).join("\n"), /old 2/);
	overlay.setLedger({ eventId: "continue-2", compactionEntryId: "compact-2", content: "new ledger", capturedAt: 1 });
	const text = overlay.render(80).join("\n");
	assert.match(text, /run continue-2 \| compaction compact-2/);
	assert.match(text, /new ledger/);
	assert.doesNotMatch(text, /old 2/);
	assert.equal(renders, 2);
});
