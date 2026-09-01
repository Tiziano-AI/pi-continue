import test from "node:test";
import assert from "node:assert/strict";
import {
	hasActiveGoalState,
	WorkflowCoordination,
	WORKFLOW_MUTEX_CHANNEL,
} from "../extensions/continue/src/workflow-coordination.ts";

function createBus() {
	const handlers = new Map<string, Array<(payload: unknown) => void>>();
	return {
		on(channel: string, handler: (payload: unknown) => void) {
			const current = handlers.get(channel) ?? [];
			current.push(handler);
			handlers.set(channel, current);
			return () => {
				const latest = handlers.get(channel) ?? [];
				const index = latest.indexOf(handler);
				if (index >= 0) latest.splice(index, 1);
			};
		},
		emit(channel: string, payload: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(payload);
		},
	};
}

function context(session: object) {
	return {
		sessionManager: session,
	};
}

function activeContract() {
	return {
		type: "custom",
		customType: "goal-contract",
		content: "Goal mode is active.",
		details: { version: 2, state: "active" },
	};
}

function inactiveContract() {
	return {
		type: "custom",
		customType: "goal-contract",
		content: "Goal mode is inactive.",
		details: { version: 2, state: "inactive" },
	};
}

test("workflow coordination claims and releases the shared agent-workflow mutex", () => {
	const events = createBus();
	const pi = { events };
	const coordination = new WorkflowCoordination(pi);
	const session = {};
	const ctx = context(session);
	coordination.bindSession(session);
	assert.equal(coordination.claimEvent(ctx, "event-1", []), "self");
	const busyProbe = { session, group: "agent-workflow", busy: false };
	events.emit(WORKFLOW_MUTEX_CHANNEL, busyProbe);
	assert.equal(busyProbe.busy, true);
	coordination.releaseEvent("event-1");
	const freeProbe = { session, group: "agent-workflow", busy: false };
	events.emit(WORKFLOW_MUTEX_CHANNEL, freeProbe);
	assert.equal(freeProbe.busy, false);
});

test("unexpected mutex result mutations fail closed", () => {
	const events = createBus();
	let mutate = true;
	events.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
		if (mutate && payload && typeof payload === "object") (payload as { busy: unknown }).busy = 0;
	});
	const coordination = new WorkflowCoordination({ events });
	const session = {};
	const ctx = context(session);
	coordination.bindSession(session);
	assert.equal(coordination.claimEvent(ctx, "mutated", []), "other");
	mutate = false;
	const probe = { session, group: "agent-workflow", busy: false };
	events.emit(WORKFLOW_MUTEX_CHANNEL, probe);
	assert.equal(probe.busy, false);
});

test("synchronous session replacement invalidates an in-flight acquisition", () => {
	const events = createBus();
	const coordination = new WorkflowCoordination({ events });
	const firstSession = {};
	const secondSession = {};
	coordination.bindSession(firstSession);
	events.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
		if (payload && typeof payload === "object" && payload.session === firstSession) {
			coordination.bindSession(secondSession);
		}
	});
	assert.equal(coordination.claimEvent(context(firstSession), "stale", []), "other");
	assert.equal(coordination.claimEvent(context(secondSession), "current", []), "self");
});

test("a Goal becoming active during acquisition invalidates the local claim", () => {
	const events = createBus();
	const coordination = new WorkflowCoordination({ events });
	const session = {};
	const branchEntries: unknown[] = [inactiveContract()];
	coordination.bindSession(session);
	events.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
		if (payload && typeof payload === "object" && payload.session === session) branchEntries.push(activeContract());
	});
	assert.equal(coordination.claimEvent(context(session), "stale-goal", [branchEntries]), "goal");
	const probe = { session, group: "agent-workflow", busy: false };
	events.emit(WORKFLOW_MUTEX_CHANNEL, probe);
	assert.equal(probe.busy, false);
});

test("active Goal state is delegated without stealing the shared mutex", () => {
	const events = createBus();
	const session = {};
	let goalHeld = true;
	events.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
		if (goalHeld && payload && typeof payload === "object" && payload.session === session) payload.busy = true;
	});
	const coordination = new WorkflowCoordination({ events });
	const result = coordination.claimEvent(context(session), "event-goal", [activeContract()]);
	assert.equal(result, "goal");
	goalHeld = false;
	coordination.releaseEvent("event-goal");
});

test("stale session observations cannot release a newer generation owner", () => {
	const events = createBus();
	const coordination = new WorkflowCoordination({ events });
	const firstSession = {};
	const secondSession = {};
	const firstContext = context(firstSession);
	const secondContext = context(secondSession);
	coordination.bindSession(firstSession);
	assert.equal(coordination.claimEvent(firstContext, "first", []), "self");
	coordination.bindSession(secondSession);
	assert.equal(coordination.claimEvent(secondContext, "second", []), "self");
	assert.equal(coordination.isGoalOwner(firstContext, [activeContract()]), false);
	const probe = { session: secondSession, group: "agent-workflow", busy: false };
	events.emit(WORKFLOW_MUTEX_CHANNEL, probe);
	assert.equal(probe.busy, true);
	coordination.unbindSession(firstSession);
	events.emit(WORKFLOW_MUTEX_CHANNEL, probe);
	assert.equal(probe.busy, true);
	coordination.releaseEvent("second");
});

test("protocol-unavailable hosts preserve standalone continuation behavior", () => {
	const events = {
		on() {
			throw new Error("event channel unavailable");
		},
		emit() {},
	};
	const coordination = new WorkflowCoordination(events);
	const session = {};
	const ctx = context(session);
	coordination.bindSession(session);
	assert.equal(coordination.isGoalOwner(ctx, [activeContract()]), false);
	assert.equal(coordination.claimEvent(ctx, "standalone", [activeContract()]), "self");
});

test("latest inactive Goal contract supersedes earlier active history", () => {
	assert.equal(hasActiveGoalState([activeContract(), inactiveContract()]), false);
	assert.equal(hasActiveGoalState([inactiveContract(), activeContract()]), true);
	assert.equal(hasActiveGoalState([{ type: "custom", customType: "goal-state", data: { goal: { status: "queued" } } }]), false);
});
