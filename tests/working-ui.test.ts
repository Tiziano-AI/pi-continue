import test from "node:test";
import assert from "node:assert/strict";
import { createContinuationRuntimeState } from "../extensions/continue/src/runtime.ts";
import {
	beginWorkingVisuals,
	clearWorkingVisuals,
	settleWorkingVisuals,
	updateWorkingVisuals,
} from "../extensions/continue/src/working-ui.ts";

test("working visuals are a compact working indicator, not a shared footer status", () => {
	const runtime = createContinuationRuntimeState();
	const calls = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg(_color, text) { return text; } },
			setWorkingMessage(message) { calls.push(["message", message]); },
			setWorkingIndicator(options) { calls.push(["indicator", options?.intervalMs, options?.frames]); },
			setStatus() { calls.push(["footer"]); },
			setEditorComponent() { calls.push(["editor"]); },
		},
	};
	beginWorkingVisuals(ctx, runtime, "continue-1", "pi-continue compacting");
	updateWorkingVisuals(ctx, runtime, "continue-2", "not our event");
	updateWorkingVisuals(ctx, runtime, "continue-1", "pi-continue resuming");
	settleWorkingVisuals(ctx, runtime, "continue-2");
	settleWorkingVisuals(ctx, runtime, "continue-1");
	assert.deepEqual(calls, [
		["message", "pi-continue compacting"],
		["indicator", 120, ["•", "•", "•", "•"]],
		["message", "pi-continue resuming"],
		["message", undefined],
		["indicator", undefined, undefined],
	]);
});

test("clearWorkingVisuals restores only the owning working indicator", () => {
	const runtime = createContinuationRuntimeState();
	const calls = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg(_color, text) { return text; } },
			setWorkingMessage(message) { calls.push(["message", message]); },
			setWorkingIndicator(options) { calls.push(["indicator", options?.intervalMs, options?.frames]); },
			setStatus() { calls.push(["footer"]); },
		},
	};
	beginWorkingVisuals(ctx, runtime, "continue-3", "pi-continue compacting");
	clearWorkingVisuals(ctx, runtime);
	clearWorkingVisuals(ctx, runtime);
	assert.deepEqual(calls, [
		["message", "pi-continue compacting"],
		["indicator", 120, ["•", "•", "•", "•"]],
		["message", undefined],
		["indicator", undefined, undefined],
	]);
});
