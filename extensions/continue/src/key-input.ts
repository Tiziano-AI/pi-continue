import {
	decodeKittyPrintable,
	Key,
	matchesKey,
	parseKey,
	StdinBuffer,
	type KeyId,
} from "@earendil-works/pi-tui";

type TextKey = "up" | "down" | "page-up" | "page-down" | "home" | "end" | "close";
type PaletteKey =
	| "up"
	| "down"
	| "left"
	| "right"
	| "enter"
	| "escape"
	| "ctrl-c"
	| "ctrl-u"
	| "backspace"
	| "delete"
	| "home"
	| "end";

const TEXT_KEY_IDS: Record<TextKey, readonly KeyId[]> = {
	up: [Key.up, "k"],
	down: [Key.down, "j"],
	"page-up": [Key.pageUp],
	"page-down": [Key.pageDown],
	home: [Key.home],
	end: [Key.end],
	close: [Key.enter, Key.return, Key.escape, Key.esc, Key.ctrl("c"), "q"],
};

const TEXT_KEY_ALIASES: Partial<Record<TextKey, readonly string[]>> = {
	"page-up": ["pageup", "page-up"],
	"page-down": ["pagedown", "page-down"],
};

const PALETTE_KEY_IDS: Record<PaletteKey, readonly KeyId[]> = {
	up: [Key.up],
	down: [Key.down],
	left: [Key.left],
	right: [Key.right],
	enter: [Key.enter, Key.return],
	escape: [Key.escape, Key.esc],
	"ctrl-c": [Key.ctrl("c")],
	"ctrl-u": [Key.ctrl("u")],
	backspace: [Key.backspace],
	delete: [Key.delete],
	home: [Key.home],
	end: [Key.end],
};

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

function splitInput(data: string): string[] {
	const buffer = new StdinBuffer({ timeout: 1_000 });
	const events: string[] = [];
	buffer.on("data", (event) => events.push(event));
	buffer.process(data);
	events.push(...buffer.flush());
	buffer.destroy();
	return events.length > 0 ? events : [data];
}

function matchesKeyId(data: string, keyIds: readonly KeyId[], aliases: readonly string[] = []): boolean {
	return keyIds.includes(data as KeyId) || aliases.includes(data) || keyIds.some((keyId) => matchesKey(data, keyId));
}

export function keyRepeat(data: string, key: TextKey): number {
	const keyIds = TEXT_KEY_IDS[key];
	const aliases = TEXT_KEY_ALIASES[key] ?? [];
	if (matchesKeyId(data, keyIds, aliases)) return 1;
	let count = 0;
	for (const event of splitInput(data)) {
		if (!matchesKeyId(event, keyIds, aliases)) return 0;
		count += 1;
	}
	return count;
}

export function keyMatches(data: string, key: PaletteKey): boolean {
	return matchesKeyId(data, PALETTE_KEY_IDS[key]);
}

export function paletteShortcutMatches(data: string, key: KeyId): boolean {
	return matchesKeyId(data, [key]);
}

function printableEvent(data: string): string | undefined {
	const kittyPrintable = decodeKittyPrintable(data);
	if (kittyPrintable !== undefined) {
		return isRawPrintableText(kittyPrintable);
	}
	const parsed = parseKey(data);
	if (parsed === Key.space) return " ";
	return parsed?.length === 1 ? parsed : undefined;
}

function isRawPrintableText(data: string): string | undefined {
	if (data.length === 0) return undefined;
	if (data.includes("\u001b")) return undefined;
	if (CONTROL_CHAR_PATTERN.test(data)) return undefined;
	return data;
}

export function palettePrintableInput(data: string): string | undefined {
	const direct = printableEvent(data);
	if (direct !== undefined) return direct;
	let output = "";
	for (const event of splitInput(data)) {
		const printable = printableEvent(event);
		if (printable !== undefined) {
			output += printable;
			continue;
		}
		const raw = isRawPrintableText(event);
		if (raw === undefined) return undefined;
		output += raw;
	}
	return output.length > 0 ? output : undefined;
}
