import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractTaggedBlock } from "./blocks.ts";
import { ScrollableTextOverlay, sanitizeOverlayText } from "./text-viewer.ts";
import type { ContinuationLedgerSnapshot } from "./types.ts";

interface LedgerTheme {
	fg(color: "accent" | "border" | "dim" | "muted", text: string): string;
	bold(text: string): string;
}

interface LedgerOverlayHandle {
	focus(): void;
	hide(): void;
}

interface TrackedLedgerOverlay {
	overlay: ContinuationLedgerOverlay;
	handle: LedgerOverlayHandle | undefined;
	closedByUser: boolean;
	closeRequested: boolean;
	pendingFocus: boolean;
}

export interface ContinuationLedgerOverlayController {
	clear(): void;
	show(ctx: ExtensionContext, ledger: ContinuationLedgerSnapshot, onLifecycleError?: () => void): Promise<boolean>;
	showSoon(ctx: ExtensionContext, ledger: ContinuationLedgerSnapshot, onError: (reason: string) => void): void;
}

function ledgerHeaderLines(ledger: ContinuationLedgerSnapshot): string[] {
	return [
		`run ${ledger.eventId ?? "unknown"} | compaction ${ledger.compactionEntryId}`,
		new Date(ledger.capturedAt).toISOString(),
	];
}

export class ContinuationLedgerOverlay extends ScrollableTextOverlay {
	constructor(
		ledger: ContinuationLedgerSnapshot,
		theme: LedgerTheme,
		done: () => void,
		requestRender: () => void,
	) {
		super(ledgerOverlayOptions(ledger), theme, done, requestRender);
	}

	setLedger(ledger: ContinuationLedgerSnapshot): void {
		this.update(ledgerOverlayOptions(ledger));
	}
}

function ledgerOverlayOptions(ledger: ContinuationLedgerSnapshot) {
	return {
		title: "Continuation Ledger",
		content: ledger.content,
		headerLines: ledgerHeaderLines(ledger),
	};
}

export function extractContinuationLedger(summary: string): string | undefined {
	return extractTaggedBlock(summary, "continuation");
}

export function buildLedgerSnapshot(
	summary: string,
	eventId: string | undefined,
	compactionEntryId: string,
): ContinuationLedgerSnapshot | undefined {
	const content = extractContinuationLedger(summary);
	if (!content) return undefined;
	return {
		eventId,
		compactionEntryId,
		content: sanitizeOverlayText(content),
		capturedAt: Date.now(),
	};
}

export function createContinuationLedgerOverlayController(): ContinuationLedgerOverlayController {
	let activeLedgerOverlay: TrackedLedgerOverlay | undefined;

	function forgetLedgerOverlay(entry: TrackedLedgerOverlay | undefined): void {
		if (activeLedgerOverlay === entry) activeLedgerOverlay = undefined;
	}

	function clear(): void {
		const entry = activeLedgerOverlay;
		if (!entry) return;
		entry.closeRequested = true;
		forgetLedgerOverlay(entry);
		if (!entry.closedByUser) entry.handle?.hide();
	}

	async function show(ctx: ExtensionContext, ledger: ContinuationLedgerSnapshot, onLifecycleError?: () => void): Promise<boolean> {
		if (!ctx.hasUI) return false;
		if (activeLedgerOverlay) {
			activeLedgerOverlay.overlay.setLedger(ledger);
			if (activeLedgerOverlay.handle) {
				activeLedgerOverlay.handle.focus();
			} else {
				activeLedgerOverlay.pendingFocus = true;
			}
			return true;
		}
		let supported = false;
		let entry: TrackedLedgerOverlay | undefined;
		const lifecycle = ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				supported = true;
				const overlay = new ContinuationLedgerOverlay(ledger, theme, () => {
					if (entry) entry.closedByUser = true;
					done();
				}, () => tui.requestRender());
				entry = { overlay, handle: undefined, closedByUser: false, closeRequested: false, pendingFocus: false };
				activeLedgerOverlay = entry;
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: {
					width: 92,
					minWidth: 48,
					maxHeight: 24,
					anchor: "center",
					margin: 1,
				},
				onHandle: (handle) => {
					if (!entry) return;
					entry.handle = handle;
					if (entry.closeRequested) {
						handle.hide();
						return;
					}
					if (entry.pendingFocus) {
						entry.pendingFocus = false;
						handle.focus();
					}
				},
			},
		);
		void lifecycle
			.catch(() => {
				if (entry && activeLedgerOverlay === entry) onLifecycleError?.();
			})
			.finally(() => {
				forgetLedgerOverlay(entry);
			});
		await Promise.resolve();
		return supported;
	}

	function showSoon(ctx: ExtensionContext, ledger: ContinuationLedgerSnapshot, onError: (reason: string) => void): void {
		void show(ctx, ledger, () => onError("Continuation Ledger could not open."))
			.then((shown) => {
				if (!shown) onError("Continuation Ledger cannot open in this Pi mode.");
			})
			.catch(() => {
				onError("Continuation Ledger could not open.");
			});
	}

	return {
		clear,
		show,
		showSoon,
	};
}

export async function showLatestContinuationLedger(
	ctx: ExtensionCommandContext,
	ledger: ContinuationLedgerSnapshot | undefined,
	overlay: ContinuationLedgerOverlayController,
): Promise<void> {
	if (!ledger) {
		if (ctx.hasUI) ctx.ui.notify("No Continuation Ledger has been created in this session yet.", "warning");
		return;
	}
	let shown = false;
	try {
		shown = await overlay.show(ctx, ledger, () => {
			if (ctx.hasUI) ctx.ui.notify("Continuation Ledger could not open.", "warning");
		});
	} catch {
		if (ctx.hasUI) ctx.ui.notify("Continuation Ledger could not open.", "warning");
		return;
	}
	if (!shown && ctx.hasUI) {
		ctx.ui.notify("Continuation Ledger cannot open in this Pi mode.", "warning");
	}
}
