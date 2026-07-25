export interface PiInternals {
	prepareCompaction: (entries: unknown[], settings: Settings) => unknown;
	estimateTokens: (message: unknown) => number;
	estimateContextTokens: (messages: unknown[]) => Context;
	convertToLlm: (messages: unknown[]) => unknown[];
	serializeConversation: (messages: unknown[]) => string;
}

export interface Settings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface Context {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

const core = "@earendil-works/pi-coding-agent";
const local = "./pi-internals-local.ts";
let internals: Promise<PiInternals> | undefined;

export function loadPiInternals(): Promise<PiInternals> {
	internals ??= Promise.all([
		import(core) as Promise<typeof import("@earendil-works/pi-coding-agent")>,
		import(local) as Promise<typeof import("./pi-internals-local.ts")>,
	]).then(([api, module]) => module.createPiInternals(api));
	return internals;
}
