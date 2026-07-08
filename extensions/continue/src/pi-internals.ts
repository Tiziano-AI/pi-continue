import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface PiInternals {
	prepareCompaction: (entries: unknown[], settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }) => unknown;
	estimateTokens: (message: unknown) => number;
	estimateContextTokens: (messages: unknown[]) => {
		tokens: number;
		usageTokens: number;
		trailingTokens: number;
		lastUsageIndex: number | null;
	};
	convertToLlm: (messages: unknown[]) => unknown[];
	serializeConversation: (messages: unknown[]) => string;
}

let cachedInternals: Promise<PiInternals> | undefined;

/** Resolve Pi internal compaction helpers from the installed package at runtime. */
export async function loadPiInternals(): Promise<PiInternals> {
	if (!cachedInternals) {
		cachedInternals = (async () => {
			const packageEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
			const distRoot = dirname(fileURLToPath(packageEntryUrl));
			const [compactionModule, messagesModule, utilsModule] = await Promise.all([
				import(pathToFileURL(join(distRoot, "core", "compaction", "compaction.js")).href),
				import(pathToFileURL(join(distRoot, "core", "messages.js")).href),
				import(pathToFileURL(join(distRoot, "core", "compaction", "utils.js")).href),
			]);
			return {
				prepareCompaction: compactionModule.prepareCompaction,
				estimateTokens: compactionModule.estimateTokens,
				estimateContextTokens: compactionModule.estimateContextTokens,
				convertToLlm: messagesModule.convertToLlm,
				serializeConversation: utilsModule.serializeConversation,
			};
		})();
	}
	return cachedInternals;
}
