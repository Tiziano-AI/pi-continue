import test from "node:test";
import assert from "node:assert/strict";
import { parseHistoryArtifacts } from "../extensions/continue/src/blocks.ts";
import type { HistoryArtifactParseFailureCode, ParsedHistoryArtifacts } from "../extensions/continue/src/types.ts";

function briefEnvelope(overrides: Record<string, unknown> = {}) {
	return {
		task: "Finish the current continuation ledger update.",
		done_when: "All gates pass and the current v4 contract is documented.",
		forbid: [
			{ rule: "Do not add parallel artifact shapes.", source: "user@msg-design-decision" },
			{ rule: "Do not edit vendor/ paths.", source: "user@msg-vendor-lock" },
		],
		established: [
			{
				claim: "The current parser accepts the seven-slot brief envelope.",
				evidence: "tests/blocks.test.ts:valid fixture",
				basis: "test",
				reopen: "if the brief keys change",
			},
			{
				claim: "Cross-service eventing uses queues, not pubsub.",
				evidence: "user@msg-arch-decision: 'use queues; pubsub loses messages we cannot lose'",
				basis: "user",
				reopen: "none",
			},
		],
		learned: [
			{
				lesson: "Embedded newlines inside a field should render as one bullet entry.",
				source: "parser normalization fixture",
			},
		],
		open: [
			{
				question: "Does the gate pass after the parser update?",
				verifies: "Run pnpm run gate and observe exit 0.",
			},
		],
		next: [
			{
				action: "Run the next validation step.",
				outcome: "A new established entry covers the validation result.",
			},
		],
		...overrides,
	};
}

function envelope(overrides: Record<string, unknown> = {}) {
	return {
		version: "pi-continue-artifacts/v4",
		brief: briefEnvelope(),
		agentGuideUpdate: { content: null, reason: "no durable guide change this cycle" },
		...overrides,
	};
}

function parseOk(text: string): ParsedHistoryArtifacts {
	const result = parseHistoryArtifacts(text);
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error(`expected parse success, got ${result.code}`);
	return result.artifacts;
}

function parseFail(text: string, code: HistoryArtifactParseFailureCode = "artifact-invalid-shape"): void {
	assert.deepEqual(parseHistoryArtifacts(text), { ok: false, code });
}

const validArtifacts = JSON.stringify(envelope());

test("parseHistoryArtifacts returns diagnostics for empty, non-JSON, and wrong-shape artifacts", () => {
	parseFail("", "artifact-empty");
	parseFail("<continuation>one</continuation>", "artifact-invalid-json");
	parseFail(JSON.stringify({ version: "wrong", brief: briefEnvelope(), agentGuideUpdate: { content: null, reason: "ok" } }));
});

test("parseHistoryArtifacts accepts the current v4 structured JSON artifact contract", () => {
	const parsed = parseOk(validArtifacts);
	assert.deepEqual(parsed, {
		briefMarkdown: [
			"## Task\nFinish the current continuation ledger update.",
			"## Done When\nAll gates pass and the current v4 contract is documented.",
			"## Forbid\n- Do not add parallel artifact shapes. — source: user@msg-design-decision\n- Do not edit vendor/ paths. — source: user@msg-vendor-lock",
			"## Established\n- The current parser accepts the seven-slot brief envelope. — evidence: tests/blocks.test.ts:valid fixture; basis: test; reopen: if the brief keys change\n- Cross-service eventing uses queues, not pubsub. — evidence: user@msg-arch-decision: 'use queues; pubsub loses messages we cannot lose'; basis: user; reopen: none",
			"## Learned\n- Embedded newlines inside a field should render as one bullet entry. — source: parser normalization fixture",
			"## Open\n- Does the gate pass after the parser update? — verifies: Run pnpm run gate and observe exit 0.",
			"## Next\n- Run the next validation step. → A new established entry covers the validation result.",
		].join("\n\n"),
		agentGuideMd: undefined,
		agentGuideChangeReason: "no durable guide change this cycle",
	});
});

test("parseHistoryArtifacts accepts one JSON Markdown fence around a valid artifact", () => {
	const wrapped = [
		"Here is the requested handoff:",
		"```JSON",
		validArtifacts,
		"```",
		"",
		"No other content belongs to the artifact.",
	].join("\n");

	assert.equal(parseOk(wrapped).briefMarkdown, parseOk(validArtifacts).briefMarkdown);
});

test("parseHistoryArtifacts reads a valid artifact through model presentation wrappers", () => {
	const fenced = (language: string) => ["```" + language, validArtifacts, "```"].join("\n");
	const expected = parseOk(validArtifacts).briefMarkdown;
	assert.equal(parseOk(fenced("typescript")).briefMarkdown, expected);
	assert.equal(parseOk([fenced("typescript"), fenced("json")].join("\n")).briefMarkdown, expected);
	assert.equal(parseOk(`<think>\nThe contract wants one JSON object.\n</think>\n\n${validArtifacts}`).briefMarkdown, expected);
	assert.equal(parseOk(`Here is the handoff:\n\n${validArtifacts}\n\nTell me if anything else is needed.`).briefMarkdown, expected);
});

test("parseHistoryArtifacts still fails closed on unusable model output", () => {
	parseFail("I was unable to summarize this session.", "artifact-invalid-json");
	parseFail(validArtifacts.slice(0, Math.floor(validArtifacts.length / 2)), "artifact-invalid-json");
	parseFail(`Here is the handoff:\n\n${JSON.stringify(envelope({ brief: { task: "only a task" } }))}`);
});

test("parseHistoryArtifacts fails closed when a response carries competing artifacts", () => {
	const other = JSON.stringify(envelope({
		brief: briefEnvelope({ task: "A different task than the final artifact claims." }),
	}));
	parseFail(["```json", validArtifacts, "```", "", "```json", other, "```"].join("\n"), "artifact-ambiguous");
});

test("parseHistoryArtifacts renders only populated brief sections", () => {
	const parsed = parseOk(JSON.stringify(envelope({
		brief: briefEnvelope({ forbid: [], established: [], learned: [], open: [], next: [] }),
	})));
	assert.equal(parsed.briefMarkdown, [
		"## Task\nFinish the current continuation ledger update.",
		"## Done When\nAll gates pass and the current v4 contract is documented.",
	].join("\n\n"));
});

test("parseHistoryArtifacts accepts a full agent guide replacement", () => {
	const parsed = parseOk(JSON.stringify(envelope({
		agentGuideUpdate: { content: "# AGENTS\n", reason: "capture corrected command truth" },
	})));
	assert.equal(parsed.agentGuideMd, "# AGENTS");
	assert.equal(parsed.agentGuideChangeReason, "capture corrected command truth");
});

test("parseHistoryArtifacts ignores unknown envelope, brief, and entry keys", () => {
	const expected = parseOk(validArtifacts).briefMarkdown;
	assert.equal(parseOk(JSON.stringify({
		version: "pi-continue-artifacts/v4",
		brief: { ...briefEnvelope(), commentary: ["noise"] },
		agentGuideUpdate: { content: null, reason: "no durable guide change this cycle", confidence: 0.4 },
		notes: "noise",
	})).briefMarkdown, expected);
	assert.equal(parseOk(JSON.stringify(envelope({
		brief: briefEnvelope({
			learned: [{
				lesson: "Embedded newlines inside a field should render as one bullet entry.",
				source: "parser normalization fixture",
				confidence: "high",
			}],
		}),
	}))).briefMarkdown, expected);
});

test("parseHistoryArtifacts requires the version and every brief slot", () => {
	const versionless = envelope();
	delete (versionless as Record<string, unknown>).version;
	parseFail(JSON.stringify(versionless));

	for (const slot of ["forbid", "established", "learned", "open", "next"]) {
		const partialBrief = briefEnvelope();
		delete (partialBrief as Record<string, unknown>)[slot];
		parseFail(JSON.stringify(envelope({ brief: partialBrief })));
		parseFail(JSON.stringify(envelope({ brief: briefEnvelope({ [slot]: null }) })));
	}
});

test("parseHistoryArtifacts rejects empty task or done_when", () => {
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ task: "" }),
	})));
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ done_when: "   " }),
	})));
});

test("parseHistoryArtifacts rejects forbid entries missing fields", () => {
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ forbid: [{ rule: "no source attribution" }] }),
	})));
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ forbid: [{ rule: "ok", source: "" }] }),
	})));
});

test("parseHistoryArtifacts rejects established basis outside the current enum", () => {
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({
			established: [{
				claim: "ok",
				evidence: "path:1",
				basis: "hearsay",
				reopen: "none",
			}],
		}),
	})));
});

test("parseHistoryArtifacts rejects established entries missing fields", () => {
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({
			established: [{ claim: "ok", evidence: "path:1", basis: "test" }],
		}),
	})));
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({
			established: [{ claim: "ok", evidence: "", basis: "test", reopen: "none" }],
		}),
	})));
});

test("parseHistoryArtifacts rejects learned entries missing fields", () => {
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ learned: [{ lesson: "no source" }] }),
	})));
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ learned: [{ lesson: "ok", source: "" }] }),
	})));
});

test("parseHistoryArtifacts rejects open entries missing fields", () => {
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ open: [{ question: "ok" }] }),
	})));
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ open: [{ question: "ok", verifies: "" }] }),
	})));
});

test("parseHistoryArtifacts rejects next entries missing fields", () => {
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ next: [{ action: "ok" }] }),
	})));
	parseFail(JSON.stringify(envelope({
		brief: briefEnvelope({ next: [{ action: "ok", outcome: "" }] }),
	})));
});

test("parseHistoryArtifacts reads an incomplete agentGuideUpdate as no replacement", () => {
	const noReplacement = (agentGuideUpdate: unknown) => {
		const payload = envelope({ agentGuideUpdate });
		if (agentGuideUpdate === undefined) delete (payload as Record<string, unknown>).agentGuideUpdate;
		const parsed = parseOk(JSON.stringify(payload));
		assert.equal(parsed.agentGuideMd, undefined);
		assert.equal(parsed.agentGuideChangeReason, "The handoff model returned no agent guide replacement.");
	};

	noReplacement(undefined);
	noReplacement(null);
	noReplacement({ reason: "" });
	noReplacement({ content: "   ", reason: null });
});

test("parseHistoryArtifacts never schedules an unexplained guide replacement", () => {
	const parsed = parseOk(JSON.stringify(envelope({
		agentGuideUpdate: { content: "# AGENTS\n" },
	})));
	assert.equal(parsed.agentGuideMd, undefined);
	assert.equal(
		parsed.agentGuideChangeReason,
		"The handoff model returned an agent guide replacement without a reason, so no guide write was scheduled.",
	);
});

test("parseHistoryArtifacts collapses multi-line and embedded-bullet field values to single lines", () => {
	const pathological = JSON.stringify(envelope({
		brief: briefEnvelope({
			open: [{
				question: "Finding 1: current artifact shape failed\n  - blocks.ts:214\n  - status.ts:130\n  - Fix: parse current shape",
				verifies: "Read both files\nand add tests",
			}],
		}),
	}));
	const parsed = parseOk(pathological);
	assert.equal(
		parsed.briefMarkdown.includes("\n  - "),
		false,
		"rendered brief must not contain nested bullet markers that the next synthesizer would re-atomize",
	);
	assert.match(
		parsed.briefMarkdown,
		/## Open\n- Finding 1: current artifact shape failed blocks\.ts:214 status\.ts:130 Fix: parse current shape — verifies: Read both files and add tests/,
	);
});
