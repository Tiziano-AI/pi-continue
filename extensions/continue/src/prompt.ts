import type { CompiledPrompt, FileOpsSnapshot, HistoryPromptAssets, HistoryPromptInput } from "./types.ts";

function escapeTaggedContent(content: string): string {
	return content
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderTag(tag: string, content: string | undefined, options: { escapeContent?: boolean } = {}): string {
	const normalized = content && content.trim().length > 0 ? content.trim() : "(none)";
	const safeContent = options.escapeContent ? escapeTaggedContent(normalized) : normalized;
	return `<${tag}>\n${safeContent}\n</${tag}>`;
}

function renderDataTag(tag: string, content: string | undefined): string {
	return renderTag(tag, content, { escapeContent: true });
}

function renderFileOps(fileOps: FileOpsSnapshot): string {
	const reads = fileOps.readFiles.length > 0 ? fileOps.readFiles.map(escapeTaggedContent).join("\n") : "(none)";
	const modified = fileOps.modifiedFiles.length > 0 ? fileOps.modifiedFiles.map(escapeTaggedContent).join("\n") : "(none)";
	return [`<read-files>`, reads, `</read-files>`, ``, `<modified-files>`, modified, `</modified-files>`].join("\n");
}

/** Compile the history-pass prompt from externalized assets plus runtime material. */
export function compileHistoryPrompt(assets: HistoryPromptAssets, input: HistoryPromptInput): CompiledPrompt {
	const sections = [
		renderTag("base-continuation-contract", assets.baseUser.content),
		renderTag("history-task", assets.scenarioUser.content),
		renderDataTag("project-root", input.projectRoot),
		renderDataTag("agent-guide-path", input.agentGuidePath),
		renderDataTag("existing-agent-guide", input.existingAgentGuide),
		renderDataTag("previous-compaction-summary", input.previousSummary),
		renderDataTag("history-to-summarize", input.historyTranscript),
		renderDataTag("turn-prefix-messages", input.turnPrefixTranscript),
		renderTag("file-operations", renderFileOps(input.fileOps)),
		renderDataTag("custom-instructions", input.customInstructions),
	];
	return {
		systemPrompt: assets.system.content.trim(),
		userPrompt: sections.join("\n\n"),
		sources: {
			system: assets.system.sourcePath,
			baseUser: assets.baseUser.sourcePath,
			scenarioUser: assets.scenarioUser.sourcePath,
		},
	};
}

/** Retry reminder for models that answer the artifact contract with prose or partial JSON. */
export const ARTIFACT_REPAIR_REMINDER = [
	"<artifact-format-retry>",
	"The previous response could not be read as the required artifact.",
	"Return only the JSON object defined by the contract above: no prose, no Markdown fences, no reasoning tags, no XML wrapper.",
	"The response must start with { and end with }.",
	"</artifact-format-retry>",
].join("\n");

/** Append the retry reminder to an already compiled history prompt. */
export function withArtifactRepairReminder(prompt: CompiledPrompt): CompiledPrompt {
	return { ...prompt, userPrompt: `${prompt.userPrompt}\n\n${ARTIFACT_REPAIR_REMINDER}` };
}

/** Render a human-readable prompt preview for the settings and preview commands. */
export function renderPromptPreview(title: string, prompt: CompiledPrompt): string {
	const parts = [
		`# ${title}`,
		``,
		`## Sources`,
		`- System: ${prompt.sources.system}`,
		prompt.sources.baseUser ? `- Base user: ${prompt.sources.baseUser}` : undefined,
		`- Scenario user: ${prompt.sources.scenarioUser}`,
		``,
		`## System Prompt`,
		prompt.systemPrompt,
		``,
		`## User Prompt`,
		prompt.userPrompt,
	].filter((entry): entry is string => entry !== undefined);
	return `${parts.join("\n")}\n`;
}
