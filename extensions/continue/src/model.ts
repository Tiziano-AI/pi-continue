import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveHistoryOutputBudget, resolveSummarizerModel } from "./model-settings.ts";
import type { ContinuationConfig, ContinuationSynthesisFailureCode, PromptPassTelemetry } from "./types.ts";

export { resolveHistoryOutputBudget, resolveSummarizerModel } from "./model-settings.ts";

export interface PromptPassResult extends PromptPassTelemetry {
	text: string;
}

export class PromptPassError extends Error {
	readonly code: ContinuationSynthesisFailureCode;
	readonly requestedModel?: string;
	readonly httpStatus?: number;

	constructor(code: ContinuationSynthesisFailureCode, options: { requestedModel?: string; httpStatus?: number } = {}) {
		super(code);
		this.code = code;
		this.requestedModel = options.requestedModel;
		this.httpStatus = options.httpStatus;
	}
}

interface PromptPassAbort {
	signal: AbortSignal;
	timedOut: () => boolean;
	cleanup: () => void;
}

function createPromptPassAbortSignal(parent: AbortSignal, timeoutMs: number): PromptPassAbort {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromParent = () => controller.abort(parent.reason);
	if (parent.aborted) abortFromParent();
	parent.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("pi-continue synthesis timed out"));
	}, timeoutMs);
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cleanup: () => {
			clearTimeout(timeout);
			parent.removeEventListener("abort", abortFromParent);
		},
	};
}

function providerAbortCode(parentSignal: AbortSignal, promptPassAbort: PromptPassAbort): ContinuationSynthesisFailureCode {
	if (promptPassAbort.timedOut()) return "provider-timeout";
	return parentSignal.aborted ? "provider-aborted" : "provider-error";
}

function requestedThinkingLevel(pi: Pick<ExtensionAPI, "getThinkingLevel">, config: ContinuationConfig): ModelThinkingLevel {
	return config.reasoning === "inherit" ? pi.getThinkingLevel() : config.reasoning;
}

/** Resolve the requested reasoning level through Pi's model-specific thinking capability map. */
export function resolveReasoningLevel(pi: Pick<ExtensionAPI, "getThinkingLevel">, model: Model<Api>, config: ContinuationConfig): ThinkingLevel | undefined {
	if (!model.reasoning) return undefined;
	const level = clampThinkingLevel(model, requestedThinkingLevel(pi, config));
	return level === "off" ? undefined : level;
}

/** Execute a history summarization pass against the resolved model and auth. */
export async function runPromptPass(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: ContinuationConfig,
	prompt: { systemPrompt: string; userPrompt: string },
	reserveTokens: number,
	signal: AbortSignal,
): Promise<PromptPassResult> {
	const model = resolveSummarizerModel(ctx, config);
	if (!model) {
		throw new PromptPassError("model-unresolved", { requestedModel: config.summarizerModel });
	}
	const requestedModel = `${model.provider}/${model.id}`;
	const outputBudget = resolveHistoryOutputBudget(model, reserveTokens, config.historyMaxTokens);
	let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch {
		throw new PromptPassError("auth-unavailable", { requestedModel });
	}
	if (!auth.ok) {
		throw new PromptPassError("auth-unavailable", { requestedModel });
	}
	const reasoning = resolveReasoningLevel(pi, model, config);
	let httpStatus: number | undefined;
	let response: Awaited<ReturnType<typeof completeSimple>>;
	const promptPassAbort = createPromptPassAbortSignal(signal, config.synthesisTimeoutMs);
	try {
		response = await completeSimple(
			model,
			{
				systemPrompt: prompt.systemPrompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt.userPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			reasoning
				? {
						apiKey: auth.apiKey,
						headers: auth.headers,
						maxTokens: outputBudget.effectiveTokens,
						reasoning,
						signal: promptPassAbort.signal,
						onResponse: (providerResponse) => {
							httpStatus = providerResponse.status;
						},
					}
				: {
						apiKey: auth.apiKey,
						headers: auth.headers,
						maxTokens: outputBudget.effectiveTokens,
						signal: promptPassAbort.signal,
						onResponse: (providerResponse) => {
							httpStatus = providerResponse.status;
						},
					},
		);
	} catch {
		throw new PromptPassError(providerAbortCode(signal, promptPassAbort), { requestedModel, httpStatus });
	} finally {
		promptPassAbort.cleanup();
	}
	if (response.stopReason === "error") {
		const code = promptPassAbort.signal.aborted ? providerAbortCode(signal, promptPassAbort) : "provider-error";
		throw new PromptPassError(code, { requestedModel, httpStatus });
	}
	if (response.stopReason === "aborted") {
		throw new PromptPassError(providerAbortCode(signal, promptPassAbort), { requestedModel, httpStatus });
	}
	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return {
		text,
		requestedModel,
		responseModel: response.responseModel,
		responseId: response.responseId,
		usage: {
			input: response.usage.input,
			output: response.usage.output,
			cacheRead: response.usage.cacheRead,
			cacheWrite: response.usage.cacheWrite,
			totalTokens: response.usage.totalTokens,
			costTotal: response.usage.cost.total,
		},
		httpStatus,
		outputBudget,
	};
}
