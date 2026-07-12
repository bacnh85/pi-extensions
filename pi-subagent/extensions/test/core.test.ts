import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "mocha";
import { discoverAgents, invalidateAgentCache } from "../agents.ts";
import { mapWithConcurrencyLimit } from "../runner.ts";
import { ThreadStore } from "../threads.ts";

describe("agent discovery", () => {
	it("parses thinking and gives project definitions precedence", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const projectDir = path.join(root, ".pi", "agents");
		const bundledDir = path.join(root, "bundled");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(bundledDir);
		writeFileSync(path.join(bundledDir, "scout.md"), "---\nname: scout\ndescription: bundled\nthinking: low\n---\nbundled");
		writeFileSync(path.join(projectDir, "scout.md"), "---\nname: scout\ndescription: project\nthinking: high\n---\nproject");
		invalidateAgentCache();
		const agent = discoverAgents(root, "project", bundledDir).agents.find((item) => item.name === "scout");
		assert.equal(agent?.source, "project");
		assert.equal(agent?.thinking, "high");
		assert.equal(agent?.systemPrompt.trim(), "project");
	});
});

describe("runner helpers", () => {
	it("enforces the concurrency ceiling and preserves result order", async () => {
		let active = 0;
		let peak = 0;
		const result = await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (value) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return value * 2;
		});
		assert.deepEqual(result, [2, 4, 6, 8]);
		assert.equal(peak, 2);
	});
});

describe("thread store", () => {
	it("tracks transitions and clears replacement-session state", () => {
		const store = new ThreadStore();
		const thread = store.createThread({ agentName: "reviewer", task: "review", mode: "single" });
		store.updateThread(thread.id, { status: "completed" });
		assert.equal(store.getThread(thread.id)?.status, "completed");
		store.clear();
		assert.deepEqual(store.getAllThreads(), []);
	});
});
