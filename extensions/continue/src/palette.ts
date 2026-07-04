import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadContinuationConfig } from "./config.ts";
import { keyMatches, palettePrintableInput, paletteShortcutMatches } from "./key-input.ts";
import { readEffectivePiCompactionSettings } from "./pi-settings.ts";
import { resolveProjectContext } from "./project.ts";
import type { ContinuationRuntimeState } from "./runtime.ts";
import { padVisible, truncateAnsi, visibleWidth } from "./tui-text.ts";
import type { ContinuationConfig } from "./types.ts";
import { actionById, isFocusActionId, PALETTE_ACTIONS, selectionFor, type ContinuePaletteResult, type FocusActionId, type PaletteAction } from "./palette-actions.ts";

const CURSOR_MARKER = "\u001b_pi:c\u0007";
const MIN_WIDTH = 44;
const TARGET_WIDTH = 76;

type PaletteColor = "accent" | "border" | "dim" | "muted" | "warning";

interface PaletteTheme {
	fg(color: PaletteColor, text: string): string;
	bold(text: string): string;
}

interface ContinuePaletteSnapshot {
	enabled: boolean;
	config: ContinuationConfig;
	threshold: string;
	contextUsage: string;
	compactionRunning: boolean;
}

interface FocusDraft {
	actionId: FocusActionId;
	text: string;
	cursor: number;
}

function topLine(theme: PaletteTheme, width: number, title: string): string {
	const label = ` ${title} `;
	const fill = Math.max(0, width - visibleWidth(label) - 2);
	return `${theme.fg("border", "+")}${theme.fg("accent", label)}${theme.fg("border", `${"-".repeat(fill)}+`)}`;
}

function bottomLine(theme: PaletteTheme, width: number): string {
	const inner = Math.max(0, width - 2);
	return theme.fg("border", `+${"-".repeat(inner)}+`);
}

function frame(theme: PaletteTheme, width: number, content: string): string {
	const inner = Math.max(0, width - 2);
	const safe = padVisible(truncateAnsi(content, inner), inner);
	return `${theme.fg("border", "|")}${safe}${theme.fg("border", "|")}`;
}

function previousCursorIndex(text: string, cursor: number): number {
	const before = Array.from(text.slice(0, cursor));
	const previous = before[before.length - 1];
	return previous ? cursor - previous.length : 0;
}

function nextCursorIndex(text: string, cursor: number): number {
	const next = Array.from(text.slice(cursor))[0];
	return next ? Math.min(text.length, cursor + next.length) : text.length;
}

function charsBeforeCursor(text: string, cursor: number): number {
	return Array.from(text.slice(0, cursor)).length;
}

function takeHead(chars: string[], maxWidth: number): string {
	let width = 0;
	let output = "";
	for (const char of chars) {
		const nextWidth = visibleWidth(char);
		if (width + nextWidth > maxWidth) break;
		output += char;
		width += nextWidth;
	}
	return output;
}

function takeTail(chars: string[], maxWidth: number): string {
	let width = 0;
	const output: string[] = [];
	for (let index = chars.length - 1; index >= 0; index -= 1) {
		const char = chars[index];
		if (!char) continue;
		const nextWidth = visibleWidth(char);
		if (width + nextWidth > maxWidth) break;
		output.unshift(char);
		width += nextWidth;
	}
	return output.join("");
}

function renderFocusField(draft: FocusDraft, maxWidth: number): string {
	const available = Math.max(1, maxWidth - 2);
	if (draft.text.length === 0) {
		const placeholder = truncateAnsi(`${CURSOR_MARKER}\u001b[7m \u001b[27mblank = normal`, available);
		return `[${padVisible(placeholder, available)}]`;
	}
	const chars = Array.from(draft.text);
	const cursorCharIndex = charsBeforeCursor(draft.text, draft.cursor);
	const cursorChar = chars[cursorCharIndex] ?? " ";
	const cursorCharWidth = Math.max(1, visibleWidth(cursorChar));
	const contentWidth = Math.max(1, available - cursorCharWidth);
	const beforeBudget = Math.floor(contentWidth * 0.6);
	let before = takeTail(chars.slice(0, cursorCharIndex), beforeBudget);
	let after = takeHead(chars.slice(cursorCharIndex + (cursorCharIndex < chars.length ? 1 : 0)), contentWidth - visibleWidth(before));
	const spare = contentWidth - visibleWidth(before) - visibleWidth(after);
	if (spare > 0) before = takeTail(chars.slice(0, cursorCharIndex), visibleWidth(before) + spare);
	const value = `${before}${CURSOR_MARKER}\u001b[7m${cursorChar}\u001b[27m${after}`;
	return `[${padVisible(value, available)}]`;
}

function renderThreshold(contextWindow: number | undefined, reserveTokens: number): string {
	if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= reserveTokens) return "unavailable";
	return `${(contextWindow - reserveTokens).toLocaleString()} tokens`;
}

function renderUsage(ctx: ExtensionCommandContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.percent === null) return "unavailable";
	return `${usage.tokens.toLocaleString()}/${usage.contextWindow.toLocaleString()} tokens (${usage.percent.toFixed(1)}%)`;
}

async function buildPaletteSnapshot(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: ContinuationRuntimeState): Promise<ContinuePaletteSnapshot> {
	const initialProjectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId());
	const config = loadContinuationConfig(initialProjectContext.projectRoot);
	const projectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId(), config.agentGuidePath);
	const compaction = readEffectivePiCompactionSettings(projectContext.projectRoot);
	const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
	return {
		enabled: config.enabled,
		config,
		threshold: renderThreshold(contextWindow, compaction.reserveTokens),
		contextUsage: renderUsage(ctx),
		compactionRunning: runtime.compactionRunning,
	};
}

export class ContinuePaletteComponent {
	focused = false;
	private selectedIndex = 0;
	private focusDraft: FocusDraft | undefined;
	private readonly snapshot: ContinuePaletteSnapshot;
	private readonly theme: PaletteTheme;
	private readonly done: (result: ContinuePaletteResult | undefined) => void;
	private readonly requestRender: () => void;

	constructor(
		snapshot: ContinuePaletteSnapshot,
		theme: PaletteTheme,
		done: (result: ContinuePaletteResult | undefined) => void,
		requestRender: () => void,
	) {
		this.snapshot = snapshot;
		this.theme = theme;
		this.done = done;
		this.requestRender = requestRender;
	}

	handleInput(data: string): void {
		if (this.focusDraft) {
			this.handleFocusInput(data);
			return;
		}
		if (keyMatches(data, "escape") || keyMatches(data, "ctrl-c")) {
			this.done(undefined);
			return;
		}
		if (keyMatches(data, "enter")) {
			this.done(selectionFor(this.selectedAction(), undefined));
			return;
		}
		if (keyMatches(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (keyMatches(data, "down")) {
			this.selectedIndex = Math.min(PALETTE_ACTIONS.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		const selectedAction = this.selectedAction();
		if (paletteShortcutMatches(data, "f") && isFocusActionId(selectedAction.id)) {
			this.focusDraft = { actionId: selectedAction.id, text: "", cursor: 0 };
			this.requestRender();
		}
	}

	render(width: number): string[] {
		if (width < MIN_WIDTH) return [truncateAnsi("Widen terminal or use /continue subcommands", width)];
		const paletteWidth = Math.min(width, TARGET_WIDTH);
		return this.focusDraft ? this.renderFocus(paletteWidth, this.focusDraft) : this.renderPalette(paletteWidth);
	}

	invalidate(): void {}

	private handleFocusInput(data: string): void {
		const draft = this.focusDraft;
		if (!draft) return;
		if (keyMatches(data, "ctrl-c")) {
			this.done(undefined);
			return;
		}
		if (keyMatches(data, "escape")) {
			this.focusDraft = undefined;
			this.requestRender();
			return;
		}
		if (keyMatches(data, "enter")) {
			const action = actionById(draft.actionId);
			if (!action) {
				this.done(undefined);
				return;
			}
			this.done(selectionFor(action, draft.text));
			return;
		}
		if (keyMatches(data, "left")) {
			draft.cursor = previousCursorIndex(draft.text, draft.cursor);
		} else if (keyMatches(data, "right")) {
			draft.cursor = nextCursorIndex(draft.text, draft.cursor);
		} else if (keyMatches(data, "home")) {
			draft.cursor = 0;
		} else if (keyMatches(data, "end")) {
			draft.cursor = draft.text.length;
		} else if (keyMatches(data, "backspace")) {
			if (draft.cursor > 0) {
				const previous = previousCursorIndex(draft.text, draft.cursor);
				draft.text = `${draft.text.slice(0, previous)}${draft.text.slice(draft.cursor)}`;
				draft.cursor = previous;
			}
		} else if (keyMatches(data, "delete")) {
			if (draft.cursor < draft.text.length) {
				const next = nextCursorIndex(draft.text, draft.cursor);
				draft.text = `${draft.text.slice(0, draft.cursor)}${draft.text.slice(next)}`;
			}
		} else if (keyMatches(data, "ctrl-u")) {
			draft.text = draft.text.slice(draft.cursor);
			draft.cursor = 0;
		} else {
			const printable = palettePrintableInput(data);
			if (printable === undefined) return;
			draft.text = `${draft.text.slice(0, draft.cursor)}${printable}${draft.text.slice(draft.cursor)}`;
			draft.cursor += printable.length;
		}
		this.requestRender();
	}

	private selectedAction(): PaletteAction {
		return PALETTE_ACTIONS[this.selectedIndex] ?? PALETTE_ACTIONS[0];
	}

	private renderPalette(width: number): string[] {
		const selected = this.selectedAction();
		const lines = [
			topLine(this.theme, width, "pi-continue"),
			frame(this.theme, width, ` ${this.theme.fg("accent", this.theme.bold("Continue"))} ${this.theme.fg("dim", "save handoff, resume here")}`),
			frame(this.theme, width, ` ${this.renderStateLine()}`),
		];
		for (const row of this.renderActionRows(width - 2)) lines.push(frame(this.theme, width, row));
		const focusHint = isFocusActionId(selected.id) ? " | f note" : "";
		lines.push(frame(this.theme, width, ` Effect: ${this.effectFor(selected)}`));
		lines.push(frame(this.theme, width, ` ${this.theme.fg("dim", `Up/Down choose | Enter select${focusHint} | Esc close`)}`));
		lines.push(bottomLine(this.theme, width));
		return lines;
	}

	private renderFocus(width: number, draft: FocusDraft): string[] {
		const action = actionById(draft.actionId) ?? this.selectedAction();
		return [
			topLine(this.theme, width, "pi-continue focus"),
			frame(this.theme, width, ` ${this.theme.fg("accent", this.theme.bold(action.label))}`),
			frame(this.theme, width, ` ${action.desc}`),
			frame(this.theme, width, ` Effect: ${this.effectFor(action)}`),
			frame(this.theme, width, ""),
			frame(this.theme, width, ` Optional note for the handoff`),
			frame(this.theme, width, ` ${renderFocusField(draft, width - 4)}`),
			frame(this.theme, width, ` ${this.theme.fg("dim", "Leave blank to continue without extra guidance.")}`),
			frame(this.theme, width, ` ${this.theme.fg("dim", "Enter to start | Esc back | Ctrl+C close")}`),
			bottomLine(this.theme, width),
		];
	}

	private renderActionRows(innerWidth: number): string[] {
		const rows: string[] = [];
		let currentSection = "";
		for (let index = 0; index < PALETTE_ACTIONS.length; index += 1) {
			const action = PALETTE_ACTIONS[index];
			if (!action) continue;
			if (action.section !== currentSection) {
				currentSection = action.section;
				rows.push(` ${this.theme.fg("muted", currentSection)}`);
			}
			rows.push(this.renderActionRow(action, index === this.selectedIndex, innerWidth));
		}
		return rows;
	}

	private renderActionRow(action: PaletteAction, selected: boolean, innerWidth: number): string {
		const pointer = selected ? ">" : " ";
		const prefix = ` ${pointer} `;
		const labelWidth = innerWidth >= 64 ? 22 : Math.min(22, Math.max(8, innerWidth - 4));
		const label = selected ? this.theme.fg("accent", action.label) : action.label;
		if (innerWidth < 58) return `${prefix}${truncateAnsi(label, Math.max(1, innerWidth - visibleWidth(prefix)))}`;
		const descriptionWidth = Math.max(1, innerWidth - visibleWidth(prefix) - labelWidth - 1);
		const description = selected ? action.desc : this.theme.fg("muted", action.desc);
		return `${prefix}${padVisible(truncateAnsi(label, labelWidth), labelWidth)} ${truncateAnsi(description, descriptionWidth)}`;
	}

	private renderStateLine(): string {
		const status = this.snapshot.enabled ? "On" : this.theme.fg("warning", "Off");
		const context = this.snapshot.contextUsage.replace(" tokens", "");
		const trigger = this.snapshot.threshold.split(" tokens")[0];
		const guard = this.snapshot.config.midRunGuardEnabled ? "safety on" : this.theme.fg("warning", "safety off");
		const running = this.snapshot.compactionRunning ? " | saving handoff" : "";
		return `${status} | context ${context} | handoff at ${trigger} | ${guard}${running}`;
	}

	private effectFor(action: PaletteAction): string {
		if (!this.snapshot.enabled && (action.id === "continue-now" || action.id === "queue")) return "Continuation is disabled; open settings to re-enable.";
		if (this.snapshot.compactionRunning && (action.id === "continue-now" || action.id === "queue")) return "A handoff is already being saved; wait or check status.";
		return action.effect;
	}
}

export interface ContinuePaletteResponse {
	supported: boolean;
	result: ContinuePaletteResult | undefined;
}

/** Show the discoverable /continue action palette and report whether Pi actually opened custom UI. */
export async function showContinuePalette(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: ContinuationRuntimeState): Promise<ContinuePaletteResponse> {
	const snapshot = await buildPaletteSnapshot(pi, ctx, runtime);
	let supported = false;
	const result = await ctx.ui.custom<ContinuePaletteResult | undefined>(
		(tui, theme, _keybindings, done) => {
			supported = true;
			return new ContinuePaletteComponent(snapshot, theme, done, () => tui.requestRender());
		},
		{
			overlay: true,
			overlayOptions: {
				width: TARGET_WIDTH,
				minWidth: MIN_WIDTH,
				maxHeight: 20,
				anchor: "center",
				margin: 1,
			},
		},
	);
	return { supported, result };
}
