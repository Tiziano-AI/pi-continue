import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Focusable } from "@earendil-works/pi-tui";
import { keyRepeat } from "./key-input.ts";
import { padVisible, stripAnsi, truncateAnsi, visibleWidth } from "./tui-text.ts";

const MIN_WIDTH = 48;
const TARGET_WIDTH = 92;
const MAX_HEIGHT = 24;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const ESCAPE_CHARACTER_PATTERN = /\u001b/g;

type ViewerColor = "accent" | "border" | "dim" | "muted";

interface ViewerTheme {
	fg(color: ViewerColor, text: string): string;
	bold(text: string): string;
}

export interface ScrollableTextOverlayOptions {
	title: string;
	content: string;
	headerLines?: string[];
	footer?: string;
}

/** Strip untrusted terminal controls before rendering model/session text in overlays. */
export function sanitizeOverlayText(content: string): string {
	return stripAnsi(content)
		.replace(/\t/g, "    ")
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL_CHARACTER_PATTERN, "")
		.replace(ESCAPE_CHARACTER_PATTERN, "");
}

function borderColor(focused: boolean): ViewerColor {
	return focused ? "border" : "muted";
}

function titleColor(focused: boolean): ViewerColor {
	return focused ? "accent" : "dim";
}

function topLine(theme: ViewerTheme, width: number, title: string, focused: boolean): string {
	const label = ` ${title} `;
	const fill = Math.max(0, width - visibleWidth(label) - 2);
	return `${theme.fg(borderColor(focused), "+")}${theme.fg(titleColor(focused), label)}${theme.fg(borderColor(focused), `${"-".repeat(fill)}+`)}`;
}

function bottomLine(theme: ViewerTheme, width: number, focused: boolean): string {
	const inner = Math.max(0, width - 2);
	return theme.fg(borderColor(focused), `+${"-".repeat(inner)}+`);
}

function frame(theme: ViewerTheme, width: number, content: string, focused: boolean): string {
	const inner = Math.max(0, width - 2);
	const safe = padVisible(truncateAnsi(content, inner), inner);
	return `${theme.fg(borderColor(focused), "|")}${safe}${theme.fg(borderColor(focused), "|")}`;
}

function wrapPlainLine(line: string, width: number): string[] {
	if (width <= 0) return [""];
	if (visibleWidth(line) <= width) return [line];
	const chunks: string[] = [];
	let current = "";
	for (const char of Array.from(line)) {
		if (visibleWidth(current + char) > width) {
			chunks.push(current);
			current = char;
		} else {
			current += char;
		}
	}
	chunks.push(current);
	return chunks;
}

function prepareTextLines(content: string, width: number): string[] {
	const inner = Math.max(1, width - 4);
	const cleaned = sanitizeOverlayText(content).trimEnd();
	if (cleaned.trim().length === 0) return ["(empty)"];
	const result: string[] = [];
	for (const line of cleaned.split("\n")) {
		for (const wrapped of wrapPlainLine(line, inner)) result.push(wrapped);
	}
	return result.length > 0 ? result : ["(empty)"];
}

export class ScrollableTextOverlay implements Focusable {
	focused = false;
	private scroll = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private title: string;
	private content: string;
	private headerLines: string[];
	private footer: string;
	private readonly theme: ViewerTheme;
	private readonly done: () => void;
	private readonly requestRender: () => void;

	constructor(
		options: ScrollableTextOverlayOptions,
		theme: ViewerTheme,
		done: () => void,
		requestRender: () => void,
	) {
		this.title = sanitizeOverlayText(options.title).trim() || "Preview";
		this.content = sanitizeOverlayText(options.content);
		this.headerLines = (options.headerLines ?? []).map((line) => sanitizeOverlayText(line));
		this.footer = options.footer ?? "↑↓/j/k scroll | PgUp/PgDn page | Enter/q/Esc close";
		this.theme = theme;
		this.done = done;
		this.requestRender = requestRender;
	}

	update(options: ScrollableTextOverlayOptions): void {
		this.title = sanitizeOverlayText(options.title).trim() || "Preview";
		this.content = sanitizeOverlayText(options.content);
		this.headerLines = (options.headerLines ?? []).map((line) => sanitizeOverlayText(line));
		this.footer = options.footer ?? "↑↓/j/k scroll | PgUp/PgDn page | Enter/q/Esc close";
		this.scroll = 0;
		this.invalidate();
		this.requestRender();
	}

	handleInput(data: string): void {
		if (keyRepeat(data, "close") > 0) {
			this.done();
			return;
		}
		const lines = this.contentLines(this.cachedWidth ?? TARGET_WIDTH);
		const page = this.pageSize();
		const maxScroll = Math.max(0, lines.length - page);
		const before = this.scroll;
		const up = keyRepeat(data, "up");
		const down = keyRepeat(data, "down");
		const pageUp = keyRepeat(data, "page-up");
		const pageDown = keyRepeat(data, "page-down");
		if (up > 0) this.scroll = Math.max(0, this.scroll - up);
		if (down > 0) this.scroll = Math.min(maxScroll, this.scroll + down);
		if (pageUp > 0) this.scroll = Math.max(0, this.scroll - page * pageUp);
		if (pageDown > 0) this.scroll = Math.min(maxScroll, this.scroll + page * pageDown);
		if (keyRepeat(data, "home") > 0) this.scroll = 0;
		if (keyRepeat(data, "end") > 0) this.scroll = maxScroll;
		if (before !== this.scroll) this.requestRender();
	}

	render(width: number): string[] {
		if (width < MIN_WIDTH) return [truncateAnsi("Widen the terminal to view this panel", width)];
		const overlayWidth = Math.min(width, TARGET_WIDTH);
		const content = this.contentLines(overlayWidth);
		const page = this.pageSize();
		const maxScroll = Math.max(0, content.length - page);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = content.slice(this.scroll, this.scroll + page);
		const focused = this.focused;
		const scrollLabel = content.length > page
			? `lines ${this.scroll + 1}-${Math.min(content.length, this.scroll + page)} of ${content.length}`
			: `${content.length} lines`;
		const footer = focused ? this.footer : "Inactive: focus this panel to scroll or close";
		return [
			topLine(this.theme, overlayWidth, this.title, focused),
			...this.headerLines.map((line) => frame(this.theme, overlayWidth, ` ${this.theme.fg("dim", line)}`, focused)),
			frame(this.theme, overlayWidth, ` ${this.theme.fg("dim", scrollLabel)}`, focused),
			frame(this.theme, overlayWidth, "", focused),
			...visible.map((line) => frame(this.theme, overlayWidth, ` ${line}`, focused)),
			frame(this.theme, overlayWidth, "", focused),
			frame(this.theme, overlayWidth, ` ${this.theme.fg("dim", footer)}`, focused),
			bottomLine(this.theme, overlayWidth, focused),
		];
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private pageSize(): number {
		return Math.max(1, MAX_HEIGHT - this.headerLines.length - 6);
	}

	private contentLines(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = prepareTextLines(this.content, width);
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

export async function showScrollableTextOverlay(
	ctx: ExtensionContext,
	options: ScrollableTextOverlayOptions,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	let supported = false;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			supported = true;
			return new ScrollableTextOverlay(options, theme, () => done(), () => tui.requestRender());
		},
		{
			overlay: true,
			overlayOptions: {
				width: TARGET_WIDTH,
				minWidth: MIN_WIDTH,
				maxHeight: MAX_HEIGHT,
				anchor: "center",
				margin: 1,
			},
		},
	);
	return supported;
}
