import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONTINUE_CONFIG } from "../extensions/continue/src/config.ts";
import { renderStatus } from "../extensions/continue/src/status.ts";
import type { ContinuationLatestEvent } from "../extensions/continue/src/types.ts";

const artifactPath = (root: string) => join(root, ".pi", "continue", "session-test.md");

function baseCtx() {
	return {
		model: {
			provider: "openai",
			id: "gpt-test",
			contextWindow: 1000,
		},
	};
}

function baseEvent(overrides: Partial<ContinuationLatestEvent> = {}): ContinuationLatestEvent {
	return {
		id: "continue-1",
		source: "command-steer",
		status: "completed",
		startedAt: 0,
		completedAt: 1000,
		artifactStatus: "modeled",
		compactionProof: { status: "verified", compactionEntryId: "compact-1", verifiedAt: 250 },
		promptStatus: "sent",
		resume: { status: "completed", startedAt: 500, completedAt: 900, stopReason: "stop" },
		outputWrites: { continuationArtifact: "off", agentGuide: "off" },
		...overrides,
	};
}

test("renderStatus reports local runtime wiring and artifact behavior", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const rendered = renderStatus(
			baseCtx(),
			DEFAULT_CONTINUE_CONFIG,
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			undefined,
		);
		assert.match(rendered, /# Continuation Status/);
		assert.match(rendered, /## Continuation/);
		assert.match(rendered, /Last handoff: none in this session/);
		assert.match(rendered, /- Handoff model: inherit -> openai\/gpt-test/);
		assert.match(rendered, /- History output budget: Pi default requested [\d,]+; effective [\d,]+; model max unavailable\./);
		assert.match(rendered, /- Continuation artifact mode: always/);
		assert.match(rendered, /- Continuation artifact path: .*\.pi[\\/]continue[\\/]session-test\.md/);
		assert.match(rendered, /- Agent guide writes: off/);
		assert.match(rendered, /- Automatic mid-run continuation: yes/);
		assert.match(rendered, /- Compaction threshold mode: reserve-tokens/);
		assert.match(rendered, /- Effective handoff trigger: unavailable/);
		assert.match(rendered, /- Adopt native threshold compaction: no \(synthesis timeout cap 180,000 ms\)/);
		assert.match(rendered, /Continuation artifacts are Pi-local per-session files/);
		assert.match(rendered, /full agentGuideUpdate\.content replacements/);
		assert.match(rendered, /- Append read file tags: no/);
		assert.match(rendered, /- Append modified file tags: yes/);
		assert.match(rendered, /- Show brief after compaction: no/);
		assert.match(rendered, /Brief entries guide the receiver; they are not proof that files were written/);
		assert.match(rendered, /- Scenario: unavailable/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus resolves percentage thresholds from the current model", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const rendered = renderStatus(
			baseCtx(),
			{
				...DEFAULT_CONTINUE_CONFIG,
				compactionThresholdMode: "percentage",
				compactionThresholdPercent: 90,
			},
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			undefined,
		);
		assert.match(rendered, /- Compaction threshold mode: percentage/);
		assert.match(rendered, /- Effective handoff trigger: 90% \(900 of 1,000 tokens\)/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus reports clamped configured history output budgets", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const ctx = {
			model: {
				provider: "openai",
				id: "gpt-small-output",
				contextWindow: 1000,
				maxTokens: 128,
			},
		};
		const rendered = renderStatus(
			ctx,
			{ ...DEFAULT_CONTINUE_CONFIG, historyMaxTokens: 1000 },
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			undefined,
		);
		assert.match(rendered, /- History output budget: configured requested 1,000; effective 128; clamped by model max 128\./);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus summarizes a completed latest continuation calmly", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const latestEvent = baseEvent({
			source: "mid-run-guard",
			trigger: {
				mode: "reserve-tokens",
				estimatedTokens: 820,
				thresholdTokens: 750,
				contextWindow: 1000,
				reserveTokens: 250,
				usageTokens: 800,
				trailingTokens: 20,
				lastUsageIndex: 3,
			},
			resume: {
				status: "completed",
				startedAt: 500,
				completedAt: 900,
				stopReason: "stop",
				requestedModel: "openai/gpt-test",
				responseModel: "openai/gpt-routed",
			},
		});
		const rendered = renderStatus(
			baseCtx(),
			DEFAULT_CONTINUE_CONFIG,
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			latestEvent,
		);
		assert.match(rendered, /Last handoff: completed successfully/);
		assert.match(rendered, /Safe boundary: completed assistant\/tool-result batch before the next model request/);
		assert.match(rendered, /Ledger: Continuation Ledger ready/);
		assert.match(rendered, /Saved handoff proof: verified package-owned pi-continue\/v4 compaction/);
		assert.match(rendered, /Output writes: none performed/);
		assert.match(rendered, /Action: No action needed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus identifies an adopted natural threshold handoff", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const rendered = renderStatus(
			baseCtx(),
			{ ...DEFAULT_CONTINUE_CONFIG, adoptNativeCompaction: true },
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			baseEvent({ source: "adopted-compaction" }),
		);
		assert.match(rendered, /- Source: adopted Pi threshold compaction\./);
		assert.match(rendered, /- Trigger: Pi natural end-of-turn threshold\./);
		assert.match(rendered, /- Safe boundary: normal assistant completion immediately before Pi's threshold compaction\./);
		assert.match(rendered, /- Adopt native threshold compaction: yes/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus tells running resumes to wait for a terminal outcome or continuation checkpoint", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const latestEvent = baseEvent({
			status: "running",
			resume: {
				status: "running",
				startedAt: 500,
				stopReason: "toolUse",
			},
		});
		const rendered = renderStatus(
			baseCtx(),
			DEFAULT_CONTINUE_CONFIG,
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			latestEvent,
		);
		assert.match(rendered, /Current state: resume is still settling/);
		assert.match(rendered, /Resume outcome: resumed assistant turn is running/);
		assert.match(rendered, /Action: Wait for the resumed assistant turn to reach a terminal assistant outcome or the next automatic continuation checkpoint\./);
		assert.doesNotMatch(rendered, /finish its first assistant response/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus reports handoff failure without failed-resume copy", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const latestEvent = baseEvent({
			id: "continue-2",
			status: "failed",
			artifactStatus: "pending",
			compactionProof: { status: "failed", failureReason: "Continuation handoff failed." },
			promptStatus: "failed",
			resume: { status: "not-requested" },
			synthesisFailure: { kind: "artifact-parse-validation", code: "artifact-invalid-json", pass: "history", requestedModel: "openai/gpt-test", httpStatus: 200 },
			failureReason: "Continuation handoff failed.",
		});
		const rendered = renderStatus(
			baseCtx(),
			DEFAULT_CONTINUE_CONFIG,
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			latestEvent,
		);
		assert.match(rendered, /Last handoff: continuation needs attention/);
		assert.match(rendered, /Synthesis failure: current artifact parse\/validation failed during history pass \(invalid JSON\); requested openai\/gpt-test; HTTP 200\./);
		assert.match(rendered, /Resume outcome: not requested/);
		assert.doesNotMatch(rendered, /resume needs attention/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus uses bounded model-provider failure diagnostics", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const secretLike = "sk-test-should-not-render";
		const latestEvent = baseEvent({
			id: "continue-3",
			status: "failed",
			artifactStatus: "aborted",
			compactionProof: { status: "failed", failureReason: "Continuation handoff failed." },
			promptStatus: "failed",
			resume: { status: "not-requested" },
			synthesisFailure: { kind: "model-provider-call", code: "auth-unavailable", pass: "history", requestedModel: "openai/gpt-test" },
			failureReason: "Continuation handoff failed.",
		});
		const rendered = renderStatus(
			baseCtx(),
			DEFAULT_CONTINUE_CONFIG,
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			latestEvent,
		);
		assert.match(rendered, /Synthesis failure: model\/provider call failed during history pass \(auth unavailable\); requested openai\/gpt-test\./);
		assert.match(rendered, /Synthesis timeout: 180,000 ms/);
		assert.doesNotMatch(rendered, new RegExp(secretLike));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus reports provider timeout diagnostics", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const latestEvent = baseEvent({
			id: "continue-4",
			status: "failed",
			artifactStatus: "aborted",
			compactionProof: { status: "failed", failureReason: "Continuation handoff failed." },
			promptStatus: "failed",
			resume: { status: "not-requested" },
			synthesisFailure: { kind: "model-provider-call", code: "provider-timeout", pass: "history", requestedModel: "openai/gpt-test" },
			failureReason: "Continuation handoff failed.",
		});
		const rendered = renderStatus(
			baseCtx(),
			DEFAULT_CONTINUE_CONFIG,
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			latestEvent,
		);
		assert.match(rendered, /Synthesis failure: model\/provider call failed during history pass \(provider timeout\); requested openai\/gpt-test\./);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus reports an aborted resume without generic internal failure copy", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const latestEvent = baseEvent({
			id: "continue-3",
			status: "failed",
			resume: {
				status: "aborted",
				startedAt: 200,
				completedAt: 900,
				failureReason: "Continuation resume was aborted.",
			},
			failureReason: "Continuation resume was aborted.",
		});
		const rendered = renderStatus(
			baseCtx(),
			DEFAULT_CONTINUE_CONFIG,
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			latestEvent,
		);
		assert.match(rendered, /Last handoff: resume was aborted/);
		assert.match(rendered, /Needs attention: Continuation resume was aborted/);
		assert.doesNotMatch(rendered, /internal failure/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("renderStatus does not call pending or failed output writes no-op writes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-status-"));
	try {
		const latestEvent = baseEvent({
			id: "continue-2",
			status: "failed",
			artifactStatus: "aborted",
			compactionProof: { status: "failed", failureReason: "Continuation handoff failed." },
			promptStatus: "failed",
			resume: {
				status: "failed",
				failureReason: "Continuation resume request failed.",
			},
			outputWrites: {
				continuationArtifact: "failed",
				agentGuide: "pending",
			},
			failureReason: "Output write failed; check the configured path and permissions.",
		});
		const rendered = renderStatus(
			baseCtx(),
			DEFAULT_CONTINUE_CONFIG,
			root,
			artifactPath(root),
			join(root, "AGENTS.md"),
			undefined,
			latestEvent,
		);
		assert.match(rendered, /Output writes: continuation artifact failed; agent guide pending/);
		assert.match(rendered, /Resume request: not sent/);
		assert.match(rendered, /Needs attention: Output write failed; check the configured path and permissions/);
		assert.doesNotMatch(rendered, /Output writes: none performed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
