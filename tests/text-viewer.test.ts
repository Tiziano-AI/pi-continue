import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeOverlayText, ScrollableTextOverlay, showScrollableTextOverlay } from "../extensions/continue/src/text-viewer.ts";

const theme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
};

const colorTheme = {
	fg(color, text) {
		const code = {
			accent: "\u001b[36m",
			border: "\u001b[34m",
			dim: "\u001b[2m",
			muted: "\u001b[90m",
		}[color];
		return `${code}${text}\u001b[0m`;
	},
	bold(text) {
		return text;
	},
};

function renderedBody(overlay) {
	return overlay.render(80).join("\n");
}

test("sanitizeOverlayText strips terminal controls", () => {
	assert.equal(
		sanitizeOverlayText("\u001b]2;title\u0007\u001b[31mred\u001b[0m\r\nline\u0000two"),
		"red\nlinetwo",
	);
});

test("ScrollableTextOverlay dims border and explains when focus is elsewhere", () => {
	const overlay = new ScrollableTextOverlay(
		{ title: "preview", content: "body" },
		colorTheme,
		() => {},
		() => {},
	);
	const unfocused = renderedBody(overlay);
	assert.match(unfocused, /\u001b\[90m\+\u001b\[0m/);
	assert.match(unfocused, /Inactive: focus this panel to scroll or close/);

	overlay.focused = true;
	const focused = renderedBody(overlay);
	assert.match(focused, /\u001b\[34m\+\u001b\[0m/);
	assert.match(focused, /Enter\/q\/Esc close/);
	assert.doesNotMatch(focused, /Inactive:/);
});

test("ScrollableTextOverlay scrolls repeated held-arrow chunks", () => {
	let renders = 0;
	const lines = Array.from({ length: 40 }, (_entry, index) => `line ${index + 1}`).join("\n");
	const overlay = new ScrollableTextOverlay(
		{ title: "preview", content: lines },
		theme,
		() => {},
		() => {
			renders += 1;
		},
	);
	assert.match(renderedBody(overlay), /\| line 1\s+\|/);
	overlay.handleInput("\u001b[B\u001b[B\u001b[B");
	const afterDown = renderedBody(overlay);
	assert.doesNotMatch(afterDown, /\| line 1\s+\|/);
	assert.match(afterDown, /\| line 4\s+\|/);
	assert.equal(renders, 1);
	overlay.handleInput("kk");
	const afterUp = renderedBody(overlay);
	assert.match(afterUp, /\| line 2\s+\|/);
});

test("ScrollableTextOverlay closes on CSI-u Escape and Enter", () => {
	let closed = 0;
	const overlay = new ScrollableTextOverlay(
		{ title: "preview", content: "x" },
		theme,
		() => {
			closed += 1;
		},
		() => {},
	);
	overlay.handleInput("\u001b[27;1u");
	overlay.handleInput("\u001b[13;1u");
	assert.equal(closed, 2);
});

test("ScrollableTextOverlay scrolls Kitty repeat key events", () => {
	let renders = 0;
	const lines = Array.from({ length: 50 }, (_entry, index) => `line ${index + 1}`).join("\n");
	const overlay = new ScrollableTextOverlay(
		{ title: "preview", content: lines },
		theme,
		() => {},
		() => {
			renders += 1;
		},
	);
	overlay.handleInput("\u001b[1;1B");
	assert.match(renderedBody(overlay), /\| line 2\s+\|/);
	overlay.handleInput("\u001b[1;1:2B\u001b[1;1:2B");
	assert.match(renderedBody(overlay), /\| line 4\s+\|/);
	overlay.handleInput("\u001b[1;1:2A");
	assert.match(renderedBody(overlay), /\| line 3\s+\|/);
	overlay.handleInput("\u001b[6;1:2~");
	assert.match(renderedBody(overlay), /\| line 21\s+\|/);
	overlay.handleInput("\u001b[5:2~");
	assert.match(renderedBody(overlay), /\| line 3\s+\|/);
	overlay.handleInput("\u001b[1;1:2F");
	assert.match(renderedBody(overlay), /\| line 33\s+\|/);
	overlay.handleInput("\u001b[1;1:2H");
	assert.match(renderedBody(overlay), /\| line 1\s+\|/);
	assert.equal(renders, 7);
});

test("ScrollableTextOverlay recomputes wrapping after width changes", () => {
	const longLine = "abcdefghij klmnopqrst uvwxyzabcd efghijklmn opqrstuvwx yzabcdefghi";
	const overlay = new ScrollableTextOverlay(
		{ title: "preview", content: longLine },
		theme,
		() => {},
		() => {},
	);
	assert.match(overlay.render(92).join("\n"), /\| 1 lines\s+\|/);
	const narrow = overlay.render(48).join("\n");
	assert.match(narrow, /\| 2 lines\s+\|/);
	assert.match(narrow, /opqrstuvwx yzabcdefghi/);
});

test("showScrollableTextOverlay reports unsupported custom UI", async () => {
	let customCalls = 0;
	const shown = await showScrollableTextOverlay(
		{
			hasUI: true,
			ui: {
				async custom() {
					customCalls += 1;
					return undefined;
				},
			},
		},
		{ title: "preview", content: "body" },
	);
	assert.equal(customCalls, 1);
	assert.equal(shown, false);
});
