interface MessageRecord {
	role: string;
	content?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	isError?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function asMessageRecord(value: unknown): MessageRecord | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.role === "string" ? { ...value, role: value.role } : undefined;
}

export function messageRole(value: unknown): string | undefined {
	return asMessageRecord(value)?.role;
}

export function assistantToolCallIds(message: unknown): string[] | undefined {
	const record = asMessageRecord(message);
	if (!record || record.role !== "assistant" || !Array.isArray(record.content)) return [];
	const ids: string[] = [];
	for (const block of record.content) {
		if (!isRecord(block) || block.type !== "toolCall") continue;
		if (typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.arguments)) return undefined;
		ids.push(block.id);
	}
	return ids;
}

export function toolResultCallId(message: unknown): string | undefined {
	const record = asMessageRecord(message);
	if (!record || record.role !== "toolResult") return undefined;
	if (typeof record.toolCallId !== "string") return undefined;
	if (typeof record.toolName !== "string") return undefined;
	if (!Array.isArray(record.content)) return undefined;
	if (typeof record.isError !== "boolean") return undefined;
	return record.toolCallId;
}

export function toolResultIdsMatchAssistant(toolResults: unknown[], assistantMessage: unknown): boolean {
	const toolCallIds = assistantToolCallIds(assistantMessage);
	if (!toolCallIds || toolCallIds.length === 0 || toolResults.length !== toolCallIds.length) return false;
	if (!hasUniqueValues(toolCallIds)) return false;
	const remainingResultIds = new Set<string>();
	for (const result of toolResults) {
		const resultId = toolResultCallId(result);
		if (!resultId) return false;
		if (remainingResultIds.has(resultId)) return false;
		remainingResultIds.add(resultId);
	}
	for (const toolCallId of toolCallIds) {
		if (!remainingResultIds.delete(toolCallId)) return false;
	}
	return remainingResultIds.size === 0;
}

function hasUniqueValues(values: string[]): boolean {
	return new Set(values).size === values.length;
}

export function isCompleteToolResultBatch(assistantMessage: unknown, toolResults: unknown[]): boolean {
	return toolResultIdsMatchAssistant(toolResults, assistantMessage);
}

/** Decide whether messages end at one complete assistant/tool-result batch. */
export function endsWithCompleteToolResultBatch(messages: unknown[]): boolean {
	if (messageRole(messages[messages.length - 1]) !== "toolResult") return false;
	let assistantIndex = messages.length - 1;
	while (assistantIndex >= 0 && messageRole(messages[assistantIndex]) === "toolResult") {
		assistantIndex--;
	}
	if (messageRole(messages[assistantIndex]) !== "assistant") return false;
	return toolResultIdsMatchAssistant(messages.slice(assistantIndex + 1), messages[assistantIndex]);
}
