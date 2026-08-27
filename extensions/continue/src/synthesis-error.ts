import type { ContinuationSynthesisFailure, ContinuationSynthesisFailureCode } from "./types.ts";

export const SYNTHESIS_ABORT_MESSAGE = "pi-continue could not create a usable handoff, so continuation stopped before resuming.";

const FAILURE_CODE_LABELS: Record<ContinuationSynthesisFailureCode, string> = {
	"model-unresolved": "model unresolved",
	"auth-unavailable": "auth unavailable",
	"provider-error": "provider error",
	"provider-aborted": "provider aborted",
	"provider-timeout": "provider timeout",
	"provider-truncated": "response stopped at the output token limit before the artifact was complete",
	"artifact-empty": "empty artifact",
	"artifact-invalid-json": "invalid JSON",
	"artifact-invalid-shape": "artifact did not match the current v4 JSON contract",
	"artifact-ambiguous": "response contained more than one candidate artifact",
	"internal-error": "internal error",
};

/** Bounded package-owned label for a synthesis failure classifier. */
export function synthesisFailureLabel(code: ContinuationSynthesisFailureCode): string {
	return FAILURE_CODE_LABELS[code] ?? FAILURE_CODE_LABELS["internal-error"];
}

/** Fixed hard-fail copy plus the bounded classifier, so a failed handoff is actionable without /continue status. */
export function describeSynthesisAbort(failure: ContinuationSynthesisFailure): string {
	return `${SYNTHESIS_ABORT_MESSAGE} Cause: ${synthesisFailureLabel(failure.code)}.`;
}
