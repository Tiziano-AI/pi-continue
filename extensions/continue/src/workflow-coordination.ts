import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_MUTEX_CHANNEL = "workflow:mutex:v1";
export const AGENT_WORKFLOW_GROUP = "agent-workflow";

export type ContinuationWorkflowOwner = "pi-continue" | "cooperative-workflow";
type WorkflowClaimResult = "self" | "goal" | "other";

type WorkflowMutexAttempt = {
	session: object;
	group: string;
	busy: boolean;
};

type EventBusLike = Pick<ExtensionAPI["events"], "emit" | "on">;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[key];
	return isRecord(candidate) ? candidate : undefined;
}

type GoalLifecycleState = "active" | "inactive";

function isGoalLifecycleEntry(customType: string | undefined, role: string | undefined): boolean {
	return customType === "goal-state" || customType === "goal-contract" || role === "goal-contract";
}

function lifecycleState(value: unknown): GoalLifecycleState | undefined {
	if (!isRecord(value)) return undefined;
	const customType = readString(value, "customType");
	const role = readString(value, "role");
	if (!isGoalLifecycleEntry(customType, role)) return undefined;
	const details = readRecord(value, "details");
	const data = readRecord(value, "data");
	const goal = readRecord(data, "goal") ?? readRecord(value, "goal");
	// goal-state 以 null 表示已清除；缺失或格式错误的对象不能被当作非活动，
	// 否则损坏的历史记录可能掩盖仍在运行的 Goal。
	if (customType === "goal-state" && isRecord(data) && Object.hasOwn(data, "goal") && data.goal === null) {
		return "inactive";
	}
	const state =
		readString(details, "state")
		?? readString(details, "status")
		?? readString(data, "status")
		?? readString(goal, "status")
		?? readString(value, "state")
		?? readString(value, "status");
	if (state === "active" || state === "running") return "active";
	if (
		state === "inactive"
		|| state === "paused"
		|| state === "completed"
		|| state === "blocked"
		|| state === "queued"
		|| state === "usage_limited"
		|| state === "budget_limited"
		|| state === "cleared"
	) {
		return "inactive";
	}
	const content = readString(value, "content") ?? readString(data, "content");
	if (content?.includes("Active /goal context:") || /Goal mode is active\b/u.test(content ?? "")) return "active";
	if (content?.includes("Goal mode is inactive")) return "inactive";
	return undefined;
}

function latestLifecycleState(value: unknown, depth = 0, seen = new Set<object>()): GoalLifecycleState | undefined {
	if (depth > 8 || value === null || value === undefined) return undefined;
	if (typeof value === "object") {
		if (seen.has(value)) return undefined;
		seen.add(value);
	}
	const direct = lifecycleState(value);
	if (direct) return direct;
	if (Array.isArray(value)) {
		let latest: GoalLifecycleState | undefined;
		for (const item of value) {
			const nested = latestLifecycleState(item, depth + 1, seen);
			if (nested) latest = nested;
		}
		return latest;
	}
	if (!isRecord(value)) return undefined;
	let latest: GoalLifecycleState | undefined;
	for (const key of [
		"message",
		"entry",
		"compactionEntry",
		"data",
		"details",
		"goal",
		"messages",
		"messagesToSummarize",
		"turnPrefixMessages",
		"branchEntries",
		"entries",
		"preparation",
		"context",
	]) {
		if (!(key in value)) continue;
		const nested = latestLifecycleState(value[key], depth + 1, seen);
		if (nested) latest = nested;
	}
	return latest;
}

/** 只把当前分支最后一个 Goal 生命周期标记视为有效，避免历史目标重新夺取压缩所有权。 */
export function hasActiveGoalState(values: readonly unknown[]): boolean {
	try {
		let latest: GoalLifecycleState | undefined;
		for (const value of values) {
			const state = latestLifecycleState(value);
			if (state) latest = state;
		}
		return latest === "active";
	} catch {
		return false;
	}
}

const GOAL_CONTINUATION_MARKER = /<!--\s*pi-goal-continuation:[^\s>]+\s*-->/u;
const GOAL_PROMPT_MARKER = /<!--\s*pi-goal-prompt:[^\s>]+\s*-->/u;

export function isGoalContinuationPrompt(text: string): boolean {
	return GOAL_CONTINUATION_MARKER.test(text);
}

function containsGoalMarker(value: unknown, depth = 0, seen = new Set<object>()): boolean {
	if (depth > 8 || value === null || value === undefined) return false;
	if (typeof value === "string") return GOAL_CONTINUATION_MARKER.test(value) || GOAL_PROMPT_MARKER.test(value);
	if (typeof value === "object") {
		if (seen.has(value)) return false;
		seen.add(value);
	}
	if (Array.isArray(value)) return value.some((item) => containsGoalMarker(item, depth + 1, seen));
	if (!isRecord(value)) return false;
	for (const key of [
		"content",
		"text",
		"prompt",
		"message",
		"entry",
		"compactionEntry",
		"data",
		"details",
		"messages",
		"messagesToSummarize",
		"turnPrefixMessages",
		"branchEntries",
		"entries",
		"preparation",
		"context",
	]) {
		if (key in value && containsGoalMarker(value[key], depth + 1, seen)) return true;
	}
	return false;
}

function currentGoalWorkflow(values: readonly unknown[]): boolean | undefined {
	try {
		// 压缩边界的第一个值是 branchEntries，只有它能确认较新的非活动契约是否
		// 已取代旧提示；只有缺少该权威序列时才检查其它载荷形状。
		for (const value of values) {
			const state = latestLifecycleState(value);
			if (state !== undefined) return state === "active";
		}
		return values.some((value) => containsGoalMarker(value));
	} catch {
		return undefined;
	}
}

function sessionObject(ctx: ExtensionContext): object | undefined {
	try {
		const session = ctx.sessionManager;
		return typeof session === "object" && session !== null ? session : undefined;
	} catch {
		return undefined;
	}
}

class LocalWorkflowMutex {
	private session: object | undefined;
	private readonly heldGroups = new Map<string, symbol>();
	private generation = 0;
	private readonly events: EventBusLike;
	private readonly protocolAvailable: boolean;

	constructor(events: EventBusLike) {
		this.events = events;
		try {
			events.on(WORKFLOW_MUTEX_CHANNEL, (payload) => this.answer(payload));
			this.protocolAvailable = true;
		} catch {
			this.protocolAvailable = false;
		}
	}

	bindSession(session: object): void {
		this.generation += 1;
		this.heldGroups.clear();
		this.session = session;
	}

	unbindSession(session: object): void {
		if (this.session !== session) return;
		this.generation += 1;
		this.heldGroups.clear();
		this.session = undefined;
	}

	supportsProtocol(): boolean {
		return this.protocolAvailable;
	}

	acquire(group = AGENT_WORKFLOW_GROUP): symbol | undefined {
		const session = this.session;
		const generation = this.generation;
		if (!session || this.heldGroups.has(group) || !this.protocolAvailable) return undefined;
		const attempt: WorkflowMutexAttempt = { session, group, busy: false };
		try {
			this.events.emit(WORKFLOW_MUTEX_CHANNEL, attempt);
		} catch {
			return undefined;
		}
		if (
			this.session !== session
			|| this.generation !== generation
			|| attempt.session !== session
			|| attempt.group !== group
			|| attempt.busy !== false
			|| this.heldGroups.has(group)
		) return undefined;
		const owner = Symbol(group);
		this.heldGroups.set(group, owner);
		return owner;
	}

	isOwner(owner: symbol | undefined, group = AGENT_WORKFLOW_GROUP): boolean {
		return owner !== undefined && this.heldGroups.get(group) === owner;
	}

	release(owner: symbol | undefined, group = AGENT_WORKFLOW_GROUP): void {
		if (!this.isOwner(owner, group)) return;
		this.heldGroups.delete(group);
	}

	private answer(payload: unknown): void {
		try {
			if (!isRecord(payload)) return;
			const attempt = payload as Partial<WorkflowMutexAttempt>;
			if (attempt.session !== this.session || attempt.group !== AGENT_WORKFLOW_GROUP || typeof attempt.busy !== "boolean") return;
			if (this.heldGroups.has(AGENT_WORKFLOW_GROUP)) attempt.busy = true;
		} catch {
			// 协议载荷可能来自其它扩展，异常必须留给协议中的其它参与者处理。
		}
	}
}

/** 在不依赖 pi-goal 实现的前提下参与同一会话的工作流互斥协议。 */
export class WorkflowCoordination {
	private readonly mutex: LocalWorkflowMutex;
	private session: object | undefined;
	private generation = 0;
	private ownedEventId: string | undefined;
	private ownedToken: symbol | undefined;

	constructor(pi: Pick<ExtensionAPI, "events">) {
		this.mutex = new LocalWorkflowMutex(pi.events);
	}

	bindSession(session: object): number {
		// reload 后同一个 manager 可能再次触发 session_start；新的生命周期不能
		// 继承上一轮的所有者或代际标记。
		this.releaseOwnedEvent();
		this.generation += 1;
		this.session = session;
		this.mutex.bindSession(session);
		return this.generation;
	}

	unbindSession(session: object): void {
		if (this.session !== session) return;
		this.releaseOwnedEvent();
		this.generation += 1;
		this.mutex.unbindSession(session);
		this.session = undefined;
	}

	getGeneration(): number {
		return this.generation;
	}

	isSelfOwner(eventId: string): boolean {
		return this.ownedEventId === eventId && this.mutex.isOwner(this.ownedToken);
	}

	isCurrent(session: object | undefined, generation: number): boolean {
		return session !== undefined && this.session === session && this.generation === generation;
	}

	/** 返回 Goal 所有权判断，同时将协议不可用视为“不参与协调”。 */
	isGoalOwner(ctx: ExtensionContext, values: readonly unknown[]): boolean {
		const session = sessionObject(ctx);
		if (!session || !this.ensureSession(session)) return false;
		if (this.ownedEventId !== undefined && this.mutex.isOwner(this.ownedToken)) return false;
		const hasGoal = currentGoalWorkflow(values);
		if (hasGoal !== true || !this.mutex.supportsProtocol()) return false;
		return true;
	}

	/** 为当前 handoff 取得唯一所有者；Goal 已持有时交给 Goal，不能抢占。 */
	claimEvent(ctx: ExtensionContext, eventId: string, values: readonly unknown[]): WorkflowClaimResult {
		const session = sessionObject(ctx);
		if (!session || !this.ensureSession(session)) return "other";
		if (this.ownedEventId === eventId && this.mutex.isOwner(this.ownedToken)) return "self";
		const goalWorkflow = currentGoalWorkflow(values);
		if (goalWorkflow === undefined) return "other";
		if (!this.mutex.supportsProtocol()) return "self";
		if (goalWorkflow) return "goal";
		const generation = this.generation;
		const token = this.mutex.acquire();
		if (!token) return "other";
		if (!this.isCurrent(session, generation)) {
			this.mutex.release(token);
			return "other";
		}
		const goalStillActive = currentGoalWorkflow(values);
		if (goalStillActive === undefined) {
			this.mutex.release(token);
			return "other";
		}
		if (goalStillActive) {
			this.mutex.release(token);
			return "goal";
		}
		this.ownedEventId = eventId;
		this.ownedToken = token;
		return "self";
	}

	releaseEvent(eventId: string): void {
		if (this.ownedEventId !== eventId) return;
		this.releaseOwnedEvent();
	}

	releaseAll(): void {
		this.releaseOwnedEvent();
	}

	private ensureSession(session: object): boolean {
		if (this.session === undefined) {
			this.bindSession(session);
			return true;
		}
		return this.session === session;
	}

	private releaseOwnedEvent(): void {
		this.mutex.release(this.ownedToken);
		this.ownedEventId = undefined;
		this.ownedToken = undefined;
	}
}
