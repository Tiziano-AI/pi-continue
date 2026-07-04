import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildContinuationCommandArgs } from "./command-shape.ts";
import { runLedgerCommand, runPreviewCommand, runResetCommand, runSettingsDialog, runStatusCommand } from "./commands.ts";
import { loadContinuationConfig } from "./config.ts";
import type { ContinuationLedgerOverlayController } from "./ledger-viewer.ts";
import type { ContinuePaletteResult } from "./palette-actions.ts";
import { sendContinuationPrompt } from "./prompt-dispatch.ts";
import { resolveProjectContext } from "./project.ts";
import { runContinuationCommand, type ContinuationRuntimeState } from "./runtime.ts";

/** Run a continuation request only when package config still enables runtime handoffs. */
export async function runEnabledContinuationCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: ContinuationRuntimeState,
	args: string | undefined,
	onContinuationFailed: (eventId: string) => void,
): Promise<void> {
	const projectContext = await resolveProjectContext(pi, ctx.cwd, ctx.sessionManager.getSessionId());
	const config = loadContinuationConfig(projectContext.projectRoot);
	if (!config.enabled) {
		if (ctx.hasUI) ctx.ui.notify("pi-continue is disabled. Re-enable it with /continue settings.", "warning");
		return;
	}
	await runContinuationCommand(
		ctx,
		runtime,
		args,
		(prompt) => sendContinuationPrompt(pi, prompt),
		onContinuationFailed,
	);
}

/** Execute the selected /continue palette action through the same canonical command paths. */
export async function runContinuePaletteResult(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: ContinuationRuntimeState,
	ledgerOverlay: ContinuationLedgerOverlayController,
	result: ContinuePaletteResult,
	onContinuationFailed: (eventId: string) => void,
): Promise<void> {
	if (result.kind === "status") {
		await runStatusCommand(pi, ctx, runtime);
		return;
	}
	if (result.kind === "ledger") {
		await runLedgerCommand(ctx, runtime, ledgerOverlay);
		return;
	}
	if (result.kind === "settings") {
		await runSettingsDialog(pi, ctx, result.scope);
		return;
	}
	if (result.kind === "reset") {
		await runResetCommand(pi, ctx, result.scope);
		return;
	}
	if (result.kind === "preview") {
		await runPreviewCommand(pi, ctx, result.instructions);
		return;
	}
	if (result.kind !== "continue") return;
	await runEnabledContinuationCommand(
		pi,
		ctx,
		runtime,
		buildContinuationCommandArgs(result.mode, result.instructions),
		onContinuationFailed,
	);
}
