import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONTINUE_CONFIG,
	NATIVE_ADOPTION_SYNTHESIS_TIMEOUT_MS,
	loadContinuationConfig,
	loadScopeConfig,
	patchContinuationConfig,
	resetContinuationConfig,
	saveContinuationConfig,
	withNativeAdoptionSynthesisTimeout,
} from "../extensions/continue/src/config.ts";

async function withTempAgent(work) {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-config-"));
	const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	delete process.env.PI_AGENT_DIR;
	try {
		return await work(root);
	} finally {
		if (previousCodingAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
		}
		if (previousAgentDir === undefined) {
			delete process.env.PI_AGENT_DIR;
		} else {
			process.env.PI_AGENT_DIR = previousAgentDir;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

test("loadContinuationConfig uses current-session model, reasoning, guard, and output defaults", async () => {
	await withTempAgent(async (root) => {
		const config = loadContinuationConfig(root);
		assert.equal(config.summarizerModel, "inherit");
		assert.equal(config.reasoning, "inherit");
		assert.equal(config.synthesisTimeoutMs, 180000);
		assert.equal(config.continuationArtifactMode, "always");
		assert.equal(config.agentGuidePath, "AGENTS.md");
		assert.equal(config.agentGuideSyncMode, "off");
		assert.equal(config.midRunGuardEnabled, true);
		assert.equal(config.adoptNativeCompaction, false);
		assert.equal(config.compactionThresholdMode, "reserve-tokens");
		assert.equal(config.compactionThresholdPercent, 90);
		assert.equal(config.appendCompactionMetadata, false);
		assert.equal(config.appendReadFileTags, false);
		assert.equal(config.appendModifiedFileTags, true);
		assert.equal(config.showAfterCompact, true);
	});
});

test("loadContinuationConfig normalizes compaction threshold settings", async () => {
	await withTempAgent(async (root) => {
		const configDir = join(root, ".pi", "extensions");
		mkdirSync(configDir, { recursive: true });
		const configPath = join(configDir, "pi-continue.json");
		writeFileSync(configPath, JSON.stringify({
			compactionThresholdMode: "percentage",
			compactionThresholdPercent: 92.5,
		}), "utf8");
		assert.equal(loadContinuationConfig(root).compactionThresholdMode, "percentage");
		assert.equal(loadContinuationConfig(root).compactionThresholdPercent, 92.5);
		writeFileSync(configPath, JSON.stringify({
			compactionThresholdMode: "tokens",
			compactionThresholdPercent: 100,
		}), "utf8");
		assert.equal(loadContinuationConfig(root).compactionThresholdMode, "reserve-tokens");
		assert.equal(loadContinuationConfig(root).compactionThresholdPercent, 90);
	});
});

test("loadContinuationConfig ignores non-boolean showAfterCompact", async () => {
	await withTempAgent(async (root) => {
		const configDir = join(root, ".pi", "extensions");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "pi-continue.json"), JSON.stringify({ showAfterCompact: "yes" }), "utf8");
		const config = loadContinuationConfig(root);
		assert.equal(config.showAfterCompact, true);
	});
});

test("loadContinuationConfig normalizes synthesis timeout", async () => {
	await withTempAgent(async (root) => {
		const configDir = join(root, ".pi", "extensions");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "pi-continue.json"), JSON.stringify({ synthesisTimeoutMs: 1.6 }), "utf8");
		assert.equal(loadContinuationConfig(root).synthesisTimeoutMs, 2);
		writeFileSync(join(configDir, "pi-continue.json"), JSON.stringify({ synthesisTimeoutMs: 0 }), "utf8");
		assert.equal(loadContinuationConfig(root).synthesisTimeoutMs, 180000);
		writeFileSync(join(configDir, "pi-continue.json"), JSON.stringify({ synthesisTimeoutMs: "fast" }), "utf8");
		assert.equal(loadContinuationConfig(root).synthesisTimeoutMs, 180000);
	});
});

test("loadContinuationConfig preserves explicit mid-run guard false", async () => {
	await withTempAgent(async (root) => {
		const configDir = join(root, ".pi", "extensions");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "pi-continue.json"), JSON.stringify({ midRunGuardEnabled: false, showAfterCompact: false }), "utf8");
		const config = loadContinuationConfig(root);
		assert.equal(config.midRunGuardEnabled, false);
		assert.equal(config.showAfterCompact, false);
	});
});

test("loadContinuationConfig preserves explicit native compaction adoption opt-in", async () => {
	await withTempAgent(async (root) => {
		const configDir = join(root, ".pi", "extensions");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "pi-continue.json"), JSON.stringify({ adoptNativeCompaction: true }), "utf8");
		assert.equal(loadContinuationConfig(root).adoptNativeCompaction, true);
		writeFileSync(join(configDir, "pi-continue.json"), JSON.stringify({ adoptNativeCompaction: "yes" }), "utf8");
		assert.equal(loadContinuationConfig(root).adoptNativeCompaction, false);
	});
});

test("native compaction adoption caps synthesis independently at 180 seconds", () => {
	assert.equal(NATIVE_ADOPTION_SYNTHESIS_TIMEOUT_MS, 180000);
	assert.equal(withNativeAdoptionSynthesisTimeout({
		...DEFAULT_CONTINUE_CONFIG,
		synthesisTimeoutMs: 600000,
	}).synthesisTimeoutMs, 180000);
	assert.equal(withNativeAdoptionSynthesisTimeout({
		...DEFAULT_CONTINUE_CONFIG,
		synthesisTimeoutMs: 2500,
	}).synthesisTimeoutMs, 2500);
});

test("loadContinuationConfig preserves explicit artifact and agent guide settings while ignoring retired document keys", async () => {
	await withTempAgent(async (root) => {
		const configDir = join(root, ".pi", "extensions");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "pi-continue.json"), JSON.stringify({
			continuationArtifactMode: "off",
			continuationDocPath: "SHOULD_NOT_SURVIVE.md",
			continuationDocSyncMode: "always",
			agentGuidePath: "docs/AGENTS.md",
			agentGuideSyncMode: "always",
		}), "utf8");
		const config = loadContinuationConfig(root);
		assert.equal("continuationDocPath" in config, false);
		assert.equal("continuationDocSyncMode" in config, false);
		assert.equal(config.continuationArtifactMode, "off");
		assert.equal(config.agentGuidePath, "docs/AGENTS.md");
		assert.equal(config.agentGuideSyncMode, "always");
	});
});

test("loadScopeConfig keeps global and project settings separate", async () => {
	await withTempAgent(async (root) => {
		await saveContinuationConfig("global", root, {
			...DEFAULT_CONTINUE_CONFIG,
			summarizerModel: "openai/global-model",
		});
		await saveContinuationConfig("project", root, {
			...DEFAULT_CONTINUE_CONFIG,
			summarizerModel: "openai/project-model",
		});
		assert.equal(loadContinuationConfig(root).summarizerModel, "openai/project-model");
		assert.equal(loadScopeConfig("global", root).summarizerModel, "openai/global-model");
		assert.equal(loadScopeConfig("project", root).summarizerModel, "openai/project-model");
	});
});

test("patchContinuationConfig preserves inherited global settings", async () => {
	await withTempAgent(async (root) => {
		await saveContinuationConfig("global", root, {
			...DEFAULT_CONTINUE_CONFIG,
			enabled: false,
		});
		await patchContinuationConfig("project", root, { showAfterCompact: false });
		const effective = loadContinuationConfig(root);
		assert.equal(effective.enabled, false);
		assert.equal(effective.showAfterCompact, false);
	});
});

test("loadContinuationConfig rejects malformed config", async () => {
	await withTempAgent(async (root) => {
		const configDir = join(root, ".pi", "extensions");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "pi-continue.json"), "{", "utf8");
		assert.throws(() => loadContinuationConfig(root), /Failed to read pi-continue config/);
	});
});

test("save and reset round-trip the mid-run guard setting", async () => {
	await withTempAgent(async (root) => {
		await saveContinuationConfig("project", root, {
			...DEFAULT_CONTINUE_CONFIG,
			midRunGuardEnabled: false,
			adoptNativeCompaction: true,
			compactionThresholdMode: "percentage",
			compactionThresholdPercent: 87.5,
			synthesisTimeoutMs: 2500,
		});
		assert.equal(loadContinuationConfig(root).midRunGuardEnabled, false);
		assert.equal(loadContinuationConfig(root).adoptNativeCompaction, true);
		assert.equal(loadContinuationConfig(root).compactionThresholdMode, "percentage");
		assert.equal(loadContinuationConfig(root).compactionThresholdPercent, 87.5);
		await resetContinuationConfig("project", root);
		assert.equal(loadContinuationConfig(root).midRunGuardEnabled, true);
		assert.equal(loadContinuationConfig(root).adoptNativeCompaction, false);
		assert.equal(loadContinuationConfig(root).compactionThresholdMode, "reserve-tokens");
		assert.equal(loadContinuationConfig(root).compactionThresholdPercent, 90);
		assert.equal(loadContinuationConfig(root).synthesisTimeoutMs, 180000);
		assert.equal(loadContinuationConfig(root).continuationArtifactMode, "always");
		assert.equal(loadContinuationConfig(root).agentGuideSyncMode, "off");
	});
});
