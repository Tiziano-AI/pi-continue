import test from "node:test";
import assert from "node:assert/strict";
import { ContinuePaletteComponent } from "../extensions/continue/src/palette.ts";
import { DEFAULT_CONTINUE_CONFIG } from "../extensions/continue/src/config.ts";

const theme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

function createSnapshot(overrides = {}) {
	return {
		enabled: true,
		projectRoot: "/tmp/project",
		config: DEFAULT_CONTINUE_CONFIG,
		compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
		threshold: "127,000 tokens (99.2% of 128,000)",
		contextUsage: "12,000/128,000 tokens (9.4%)",
		compactionRunning: false,
		...overrides,
	};
}

function stripAnsi(value) {
	return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b_[^\u0007]*\u0007/g, "");
}

function assertLineWidths(lines, width) {
	for (const line of lines) assert.ok(stripAnsi(line).length <= width, line);
}

test("ContinuePaletteComponent renders a compact action palette", () => {
	const component = new ContinuePaletteComponent(createSnapshot(), theme, () => {}, () => {});
	const lines = component.render(96);
	const text = stripAnsi(lines.join("\n"));
	assert.match(text, /Continue this run now/);
	assert.match(text, /Continue when idle/);
	assert.match(text, /Preview handoff/);
	assert.match(text, /Show ledger/);
	assert.match(text, /Project settings/);
	assert.match(text, /Reset project/);
	assert.match(text, /Effect: Stops the current assistant turn if needed before saving/);
	assert.match(text, /Up\/Down choose \| Enter select \| f note \| Esc close/);
	assert.doesNotMatch(text, /Project: \/tmp\/project/);
	assert.equal(lines.length, 18);
	assertLineWidths(lines, 96);
});

test("ContinuePaletteComponent keeps palette height stable while browsing", () => {
	const component = new ContinuePaletteComponent(createSnapshot(), theme, () => {}, () => {});
	const heights = [component.render(72).length];
	for (let index = 0; index < 7; index += 1) {
		component.handleInput("down");
		heights.push(component.render(72).length);
	}
	assert.deepEqual([...new Set(heights)], [18]);
});

test("ContinuePaletteComponent runs selected actions without hidden focus text", () => {
	let selected;
	const component = new ContinuePaletteComponent(createSnapshot(), theme, (result) => {
		selected = result;
	}, () => {});
	component.handleInput("x");
	component.handleInput("tab");
	component.handleInput("enter");
	assert.deepEqual(selected, { kind: "continue", mode: "steer", instructions: undefined });
});

test("ContinuePaletteComponent captures optional focus from the focus screen", () => {
	let selected;
	let renders = 0;
	const component = new ContinuePaletteComponent(createSnapshot(), theme, (result) => {
		selected = result;
	}, () => {
		renders += 1;
	});
	component.handleInput("f");
	for (const char of "finish tests") component.handleInput(char);
	component.handleInput("enter");
	assert.deepEqual(selected, { kind: "continue", mode: "steer", instructions: "finish tests" });
	assert.equal(renders, "finish tests".length + 1);
});

test("ContinuePaletteComponent opens focus mode with CSI-u base-layout f shortcut", () => {
	let selected;
	const component = new ContinuePaletteComponent(createSnapshot(), theme, (result) => {
		selected = result;
	}, () => {});
	component.handleInput("\u001b[1092::102;1u");
	for (const char of "via key identity") component.handleInput(char);
	component.handleInput("enter");
	assert.deepEqual(selected, { kind: "continue", mode: "steer", instructions: "via key identity" });
});

test("ContinuePaletteComponent keeps Unicode focus text and rejects CSI-u controls", () => {
	let selected;
	const component = new ContinuePaletteComponent(createSnapshot(), theme, (result) => {
		selected = result;
	}, () => {});
	component.handleInput("f");
	for (const char of "测试🙂é") component.handleInput(char);
	component.handleInput("\u001b[133;1u");
	component.handleInput("\u001b[9;1u");
	component.handleInput("enter");
	assert.deepEqual(selected, { kind: "continue", mode: "steer", instructions: "测试🙂é" });
});

test("ContinuePaletteComponent captures queue and preview focus actions", () => {
	const queueResults = [];
	const queueComponent = new ContinuePaletteComponent(createSnapshot(), theme, (result) => {
		queueResults.push(result);
	}, () => {});
	queueComponent.handleInput("down");
	queueComponent.handleInput("f");
	for (const char of "leave tools alone") queueComponent.handleInput(char);
	queueComponent.handleInput("enter");

	const previewResults = [];
	const previewComponent = new ContinuePaletteComponent(createSnapshot(), theme, (result) => {
		previewResults.push(result);
	}, () => {});
	previewComponent.handleInput("down");
	previewComponent.handleInput("down");
	previewComponent.handleInput("f");
	for (const char of "show prompt focus") previewComponent.handleInput(char);
	previewComponent.handleInput("enter");

	assert.deepEqual(queueResults[0], { kind: "continue", mode: "queue", instructions: "leave tools alone" });
	assert.deepEqual(previewResults[0], { kind: "preview", instructions: "show prompt focus" });
});

test("ContinuePaletteComponent backs out of focus mode without saving hidden text", () => {
	let selected;
	const component = new ContinuePaletteComponent(createSnapshot(), theme, (result) => {
		selected = result;
	}, () => {});
	component.handleInput("f");
	for (const char of "do not keep") component.handleInput(char);
	component.handleInput("escape");
	component.handleInput("enter");
	assert.deepEqual(selected, { kind: "continue", mode: "steer", instructions: undefined });
});

test("ContinuePaletteComponent handles Pi TUI escape and enter key events", () => {
	let selected;
	const component = new ContinuePaletteComponent(createSnapshot(), theme, (result) => {
		selected = result;
	}, () => {});
	component.handleInput("f");
	for (const char of "do not keep") component.handleInput(char);
	component.handleInput("\u001b[27;1u");
	component.handleInput("\u001b[13;1u");
	assert.deepEqual(selected, { kind: "continue", mode: "steer", instructions: undefined });
});

test("ContinuePaletteComponent keeps the cursor marker visible for long focus text", () => {
	const component = new ContinuePaletteComponent(createSnapshot(), theme, () => {}, () => {});
	component.handleInput("f");
	for (const char of "focus on a very long validation path before release") component.handleInput(char);
	const lines = component.render(56);
	assert.match(lines.join("\n"), /\u001b_pi:c\u0007/);
	assertLineWidths(lines, 56);
});
