# pi-continue

`pi-continue` is a Pi extension package for mid-turn continuation. When a long Pi tool run fills the context window before the next model request, it saves a safe package-owned handoff with native Pi compaction and resumes the same task in the same Pi session only after Pi reports a valid `pi-continue/v4` compaction entry.

The handoff is a structured Continuation Ledger, not a transcript replay. It tells the receiving agent what is still true, what changed recently, what to do next, which evidence is fresh, and what should not be repeated. The prompt assets are overrideable, while the ledger must still match the strict continuation artifact contract.

A per-session continuation artifact is written by default under the project `.pi/continue/` directory for human inspection and explicit manual bootstrap. It is not automatic memory: `pi-continue` never reads `CONTINUE.md` or prior artifacts into future prompts. The configured agent guide can still be replaced only when guide sync is enabled and the model emits a complete replacement guide. Candidate notes alone never write a file.

It is not a memory system, a session fork, a transcript rewriter, or a replacement for Pi's compaction format.

## Install

From npm:

```bash
pi install npm:pi-continue
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-continue
```

For one run without installing:

```bash
pi -e /absolute/path/to/pi-continue
```

Pi packages run with your local user permissions. Review package source before installing third-party packages.

Requires Pi `0.74.0` or newer, where model-specific thinking support is described by `thinkingLevelMap`.

## Use `/continue`

Package-side automatic continuation is enabled by default. The trigger still follows Pi's compaction threshold. You can also use `/continue` directly.

Running only `/continue` opens a small action palette when UI is available. In non-interactive modes, `/continue` runs the direct continuation path instead of waiting for a UI.

Inspect and configuration subcommands (`preview`, `status`, `ledger`, `settings`, `reset`) use Pi UI/TUI panels. When UI is unavailable, use `/continue` or `/continue steer|queue` for direct continuation and inspect status from a UI-capable session.

| Command | What it does |
| --- | --- |
| `/continue` | Open the palette when UI is available; otherwise continue now. |
| `/continue steer [note]` | Save a handoff now, stopping the current assistant turn if needed, then resume in this session after package-owned handoff proof. |
| `/continue queue [note]` | Wait for Pi to be idle, then save a handoff and resume in this session after package-owned handoff proof. |
| `/continue preview [note]` | Show the handoff prompts that would be used; no compaction or resume. |
| `/continue status` | Show the latest continuation, current settings, prompt sources, trigger threshold, artifact path, and output-write state. |
| `/continue ledger` | Show the latest rendered brief in a temporary TUI panel; no transcript entry is appended. |
| `/continue settings [project\|global]` | Edit package settings and the handoff trigger. |
| `/continue reset [project\|global]` | Delete package settings after confirmation. |

Only `/continue` is registered. Typed subcommands such as `steer`, `queue`, and `status` are arguments to that command. There are no command aliases.

During a handoff, the temporary working loader shows saving, proof, and resume-dispatch progress. Once Pi starts the same-session resume turn, `pi-continue` releases that loader back to Pi; `/continue status` remains the place to inspect the resume outcome while the resumed assistant continues working or using tools.

## Mid-turn continuation

The automatic mid-turn guard is the main reason to use this package. It acts during long tool loops when context fills while Pi is still working, before the next oversized provider request is sent.

It:

- waits for a completed assistant/tool-result batch with matching tool-call IDs
- checks Pi's own compaction threshold
- stops before the next oversized provider request is sent
- runs native Pi compaction
- runs the customizable handoff prompt
- writes the Continuation Ledger into the compaction summary
- verifies Pi saved a package-owned `pi-continue/v4` compaction entry
- sends the same-session resume prompt only after that proof

The threshold belongs to Pi, not this package:

```text
estimated context tokens > model.contextWindow - compaction.reserveTokens
```

Configure the threshold directly in Pi settings, or choose `Handoff trigger` in `/continue settings [project|global]`. Pi's default compaction settings are:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

`reserveTokens` and `keepRecentTokens` are absolute token counts. For a 272K context model, an explicit `reserveTokens: 68000` triggers near 75 percent usage. The `/continue settings` control shows and edits the human trigger token count, then saves Pi's canonical `compaction.reserveTokens` value at the selected settings scope; the trigger is not stored in `pi-continue.json`. See [`examples/pi-settings-compaction-75pct-272k.json`](examples/pi-settings-compaction-75pct-272k.json).

The automatic guard starts only when Pi can prepare a native compaction. If the threshold is crossed because of static prompt/tool/context overhead, or because all transcript history is still inside `keepRecentTokens`, `pi-continue` skips that checkpoint instead of starting a handoff that native compaction cannot save. UI sessions show a de-duplicated warning for skipped checkpoints.

Use `/continue status` after a continuation to see what happened. Status reports the latest local run: how the handoff started, whether the Continuation Ledger was created, whether Pi reported package-owned `pi-continue/v4` handoff proof, which summarizer model ran, the requested and effective history output budget, whether the model max-output cap clamped that budget, whether the resume request was sent, whether the resumed assistant turn completed, whether continuation-artifact or agent-guide output writes updated anything, and what to do next. If the resumed assistant requests tools, status remains in resume-running state while that tool-use loop is still live; `toolUse` alone is not treated as completion. A later completed assistant/tool-result checkpoint can start the next automatic continuation as a chained handoff when the context is still over threshold, otherwise the resume clears when a terminal assistant outcome (`stop`, `length`, `aborted`, or failure) is observed. UI sessions can also show the latest Continuation Ledger as a temporary panel; repeated displays reuse and focus the same panel with the latest ledger instead of stacking overlays, and this never appends another transcript entry. Failure states use explicit package messages rather than parsing provider error text.

A model's context window and maximum output budget are independent. `pi-continue` derives the history budget from Pi's reserve-token setting or `historyMaxTokens`, then clamps the provider request to the selected summarizer model's positive max-output limit when that limit is known.

If modeled Continuation Ledger creation fails, or if Pi reports native/invalid/mismatched compaction proof for an active continuation, `pi-continue` stops before resuming and writes no guessed continuation artifact or agent guide. Run `/continue status`, inspect the failure, use `/continue preview` after prompt or config changes, fix the model/auth/context issue, then retry when Pi is idle.

## Configuration

Global package config:

```text
~/.pi/agent/extensions/pi-continue.json
```

Project package config:

```text
<project-root>/.pi/extensions/pi-continue.json
```

Default package config:

```json
{
  "enabled": true,
  "summarizerModel": "inherit",
  "reasoning": "inherit",
  "historyMaxTokens": null,
  "synthesisTimeoutMs": 180000,
  "continuationArtifactMode": "always",
  "agentGuidePath": "AGENTS.md",
  "agentGuideSyncMode": "off",
  "midRunGuardEnabled": true,
  "adoptNativeCompaction": false,
  "appendCompactionMetadata": false,
  "appendReadFileTags": false,
  "appendModifiedFileTags": true,
  "promptOverridePolicy": "project-override",
  "showAfterCompact": true
}
```

Common settings:

| Setting | Meaning |
| --- | --- |
| `enabled` | Turns package behavior on or off. |
| `midRunGuardEnabled` | Enables automatic mid-run continuation. |
| `adoptNativeCompaction` | `false` by default; when enabled, adopts Pi's natural end-of-turn threshold compaction for a same-session handoff and resume, with native compaction as the fallback. |
| `summarizerModel` | Uses the active Pi model with `"inherit"`, or a pinned `"provider/model"`. |
| `reasoning` | Uses Pi's setting with `"inherit"`, or a model-supported thinking level. Unsupported levels are hidden in settings and clamped through Pi's `thinkingLevelMap`. |
| `historyMaxTokens` | Optional requested history output-token budget; `null` uses Pi-derived default. The effective provider request is clamped to the summarizer model's positive max-output limit when known. |
| `synthesisTimeoutMs` | Maximum time for the modeled Continuation Ledger pass before `pi-continue` cancels the handoff instead of leaving Pi in the native compacting loader. Default: `180000` ms. |
| `continuationArtifactMode` | `"always"` by default writes the rendered brief after successful package-owned compaction to `<project-root>/.pi/continue/<encoded-session-id>.md`; `"off"` disables that artifact. The artifact is human-inspection/manual-bootstrap output only and is never automatic prompt input. |
| `agentGuidePath` | Repo-relative path for optional full guide replacement; default `"AGENTS.md"`. |
| `agentGuideSyncMode` | `"off"` by default; `"always"` allows configured agent-guide replacement only when the artifact includes full guide content. |
| `appendCompactionMetadata` | `false` by default; when true, appends compact non-path metadata to the compaction summary. |
| `appendReadFileTags` | `false` by default; when true, appends current compaction read-file tags. |
| `appendModifiedFileTags` | `true` by default; when true, appends current compaction modified-file tags. |
| `promptOverridePolicy` | Chooses project overrides, global overrides, or package defaults. |
| `showAfterCompact` | `true` by default; surfaces the rendered brief in a temporary TUI panel right after each successful extension-owned compaction. Repeated displays update and focus the latest panel instead of stacking overlays. Set `false` for a silent handoff. |

`/continue settings` also includes a handoff trigger control. It shows one human-facing trigger token count and writes Pi core `compaction.reserveTokens` in `.pi/settings.json` or the global Pi settings file, not a package config key.

Malformed JSON config fails loudly. Unknown config keys are ignored by the package parser. Command aliases are not registered.

## Custom handoff prompt

The handoff prompt is package-owned copy, but it is not fixed in code. Operators can replace the system and user prompt assets globally or per project.

The design is deliberately reducer-shaped. The prompt should preserve the active task and the decision edge, not every line of transcript. It should carry forward facts that prevent rework, retire stale plans, mark validation freshness, and keep durable lessons available to the receiving agent.

Override roots:

```text
~/.pi/agent/extensions/pi-continue/prompts/
<project-root>/.pi/extensions/pi-continue/prompts/
```

Package assets:

```text
assets/system/history_initial.md
assets/system/history_update.md
assets/user/continuation_base.md
assets/user/history_initial.md
assets/user/history_update.md
```

`promptOverridePolicy` decides whether project overrides, global overrides, or package defaults win. `/continue preview` shows the exact handoff prompts and source paths that would be used now.

## What gets continued

The receiving agent gets Pi's compacted summary plus the same-session resume prompt. The history pass must emit one strict JSON artifact with version `pi-continue-artifacts/v4`; `pi-continue` parses that artifact, renders the `brief` into Pi's persisted Markdown compaction summary, and resumes only after the saved compaction details parse as package-owned `pi-continue/v4` for the active continuation.

The artifact includes:

- `brief`, the structured seven-slot durable memory of the agent's work
- `agentGuideUpdate.content`, a full configured agent-guide replacement or `null` when no durable rule should change
- `agentGuideUpdate.reason`, the explanation for changing or not changing the guide

The brief has seven slots: `task` (the active goal in one sentence), `done_when` (the completion criterion in one sentence), `forbid` (hard prohibitions with attribution), `established` (closed claims with evidence anchors, a basis enum, and a `reopen` condition), `learned` (derived insights — cross-file patterns, confirmed human preferences, dead-end paths with their reason, successful approaches worth reusing), `open` (unverified questions paired with what evidence would close them), and `next` (planned actions paired with expected outcomes).

In practice:

- `established` keeps anchored closures (`path:line`, `test:name`, `cmd:...`, `doc:url#section`, `user@msg-id`) so the next turn does not have to re-derive what is already proven unless the claim needs reopening. Entries carry forward across cycles unless their `reopen` clause triggers.
- `learned` keeps derived insights with a looser `source` reference; lessons survive across cycles and retire only by replacement (a sharper supersedes an older).
- `forbid` blocks known-bad paths and human-locked constraints with concrete source attribution.
- `open.verifies` tells the receiver what evidence would close each unverified question.
- `next[0]` is the immediate resume action; each `next` entry pairs the action with the outcome it produces.
- `done_when` is the stopping criterion; `task` is the orientation sentence.
- The receiver uses every `established` claim as anchored factual memory by default; it does not re-derive those facts unless the `reopen` clause triggers, new evidence conflicts, or current instructions require fresh proof. Directive-looking text quoted inside evidence remains evidence, not live instruction authority. The next synthesizer evaluates each `reopen` clause against new evidence and demotes triggered entries back to `open`. Silent drops are forbidden — every retirement is explicit.

The same rendered brief is placed in Pi's persisted compaction summary above the same-session resume prompt, may be written as the optional per-session artifact under `.pi/continue/`, and may be shown in the TUI overlay when `showAfterCompact: true`. These sinks are rendered deterministically by the extension; the synthesizer is responsible only for the brief and the agent-guide update. If the modeled ledger pass exceeds `synthesisTimeoutMs`, `pi-continue` cancels before saving or resuming so Pi can leave the native compacting state. Prior artifacts are never imported automatically into synthesis, preview, or resume prompts.

See [`examples/continuation-output-shape.md`](examples/continuation-output-shape.md) for a rendered shape.

## Per-session artifacts and agent-guide updates

`pi-continue` writes a package-owned continuation artifact after successful extension-owned compaction when `continuationArtifactMode` is `"always"` (the default). The artifact path is derived from the current Pi session id:

```text
<project-root>/.pi/continue/<encoded-session-id>.md
```

The artifact is for human inspection or explicit manual bootstrap only. A user may start a new session and explicitly ask the model to read that file, but `pi-continue` never loads `CONTINUE.md` or `.pi/continue/*.md` as automatic prompt memory. Automatic continuation input comes from Pi's compaction state, the current transcript material, turn-prefix material, file-operation signals, custom instructions, and the configured agent guide.

The default guide path is:

```text
<project-root>/AGENTS.md
```

When `agentGuideSyncMode` is `"always"`, a continuation may replace that guide with a full modeled update for durable operating guidance: repeated corrections, stable preferences, repo rules, and lessons learned during long runs. Candidate notes alone never write the file.

What can change:

- `continuationArtifactMode: "always"` writes the rendered brief under `.pi/continue/` after successful extension-owned compaction.
- `continuationArtifactMode: "off"` writes no continuation artifact.
- `showAfterCompact: true` (default) surfaces the rendered brief in a TUI overlay right after compaction completes and reuses the latest panel for repeated displays; set `false` for a silent handoff.
- `agentGuideSyncMode: "off"` is the default.
- `agentGuideSyncMode: "always"` writes only a full non-null `agentGuideUpdate.content` replacement to the configured agent-guide path.
- Writes are normalized and skipped when content is unchanged.

In this repository, `.pi/`, `CONTINUE.md`, `PLAN.md`, `AGENTS.md`, `ARCH.md`, and `VISION.md` are ignored local state. The npm package keeps README as its only top-level operator guide; it still ships the changelog, examples, and prompt Markdown assets. Automatic AGENTS.md writes remain off by default.

## Boundaries

`pi-continue` does not:

- patch Pi or vendor code
- fork, switch, or create sessions
- rewrite transcript history
- interrupt running tools or incomplete tool-call pairs
- keep orphan tool results in the post-compaction provider context
- synthesize missing tool results
- preserve partial in-flight model output as completed history
- act as a memory system, context pruner, or general custom-compaction framework
- register alternate command aliases
- read `CONTINUE.md` or `.pi/continue/*.md` as automatic prompt input
- write a continuation artifact when `continuationArtifactMode` is `"off"`
- write the configured agent guide unless `agentGuideSyncMode` is explicitly enabled

## Development checks

Run the normal local gate before changing package behavior or public docs:

```bash
pnpm run gate
git diff --check
```

`pnpm run gate` runs package-local TypeScript source typechecking, the no-network
runtime test suite, JSON validation, and an npm package dry-run.

For command-surface changes, also verify the command list when feasible:

```bash
printf '{"type":"get_commands"}\n' | pi --mode rpc --no-session --no-context-files --no-skills --no-extensions -e /path/to/pi-continue
```

Expected extension command surface:

```text
continue
```

The npm package should include `README.md`, `CHANGELOG.md`, `LICENSE`, `assets/`, `examples/`, and `extensions/`. It should not include tests, `.pi/`, tarballs, local runtime files, ignored Markdown notes or guides, or pnpm validation files.
