import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { MuninClient } from "@kalera/munin-sdk";
import muninExtension from "../index";

const ENV_KEYS = ["MUNIN_API_KEY", "MUNIN_PROJECT", "MUNIN_BASE_URL", "PI_CODING_AGENT_DIR"] as const;

function harness(confirm = false) {
	const tools: Record<string, any> = {};
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, any> = {};
	const notifications: string[] = [];
	const pi: any = {
		registerTool(tool: any) { tools[tool.name] = tool; },
		registerCommand(name: string, command: any) { commands[name] = command; },
		on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
	};
	muninExtension(pi);
	const ctx: any = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		ui: {
			confirm: async () => confirm,
			notify: (message: string) => notifications.push(message),
		},
	};
	return { tools, handlers, commands, notifications, ctx };
}

describe("pi-munin extension", () => {
	let dirs: string[];
	let originalEnv: Record<string, string | undefined>;
	let originalCapabilities: typeof MuninClient.prototype.capabilities;
	let originalInvoke: typeof MuninClient.prototype.invoke;

	beforeEach(() => {
		dirs = [];
		originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of ENV_KEYS) delete process.env[key];
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-munin-test-global-"));
		dirs.push(process.env.PI_CODING_AGENT_DIR);
		originalCapabilities = MuninClient.prototype.capabilities;
		originalInvoke = MuninClient.prototype.invoke;
	});

	afterEach(() => {
		MuninClient.prototype.capabilities = originalCapabilities;
		MuninClient.prototype.invoke = originalInvoke;
		for (const key of ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	function projectDir(): string {
		const cwd = mkdtempSync(join(tmpdir(), "pi-munin-test-project-"));
		dirs.push(cwd);
		writeFileSync(join(cwd, ".env.local"), "MUNIN_API_KEY=project-key\nMUNIN_PROJECT=project-id\n");
		return cwd;
	}

	it("registers eight tools with named prompt guidelines", () => {
		const { tools } = harness();
		expect(Object.keys(tools)).to.have.length(8);
		for (const tool of Object.values(tools) as any[]) {
			for (const guideline of tool.promptGuidelines) expect(guideline).to.include(tool.name);
		}
		expect(tools.munin_delete.parameters.properties).to.not.have.property("force");
	});

	it("uses trusted project env in the prompt hook and status command", async () => {
		const h = harness();
		h.ctx.cwd = projectDir();
		const result = await h.handlers.before_agent_start[0]({ systemPrompt: "BASE" }, h.ctx);
		expect(result.systemPrompt).to.include("Munin Memory Protocol");
		await h.commands["munin-status"].handler("", h.ctx);
		expect(h.notifications[0]).to.include("Project: project-id");
	});

	it("throws for invalid munin_store tags", async () => {
		const { tools, ctx } = harness();
		try {
			await tools.munin_store.execute("id", {
				key: "valid-key",
				title: "Title",
				content: "Content",
				tags: "type:fact",
			}, undefined, undefined, ctx);
			expect.fail("Expected invalid tags to throw");
		} catch (error) {
			expect((error as Error).message).to.include("Tag validation failed");
		}
	});

	it("cancels delete and share before SDK dispatch", async () => {
		const { tools, ctx } = harness(false);
		MuninClient.prototype.invoke = async () => { throw new Error("SDK should not be called"); };
		const deleted = await tools.munin_delete.execute("id", { key: "memory-key" }, undefined, undefined, ctx);
		const shared = await tools.munin_share.execute("id", {
			memory_ids: ["memory-id"],
			target_project_ids: ["target-id"],
		}, undefined, undefined, ctx);
		expect(deleted.details.cancelled).to.equal(true);
		expect(shared.details.cancelled).to.equal(true);
	});

	it("calls capabilities with forceRefresh instead of a project payload", async () => {
		const { tools, ctx } = harness();
		process.env.MUNIN_API_KEY = "key";
		process.env.MUNIN_PROJECT = "project";
		const args: unknown[] = [];
		MuninClient.prototype.capabilities = async function (forceRefresh?: boolean) {
			args.push(forceRefresh);
			return { specVersion: "v1" } as any;
		};
		const result = await tools.munin_capabilities.execute("id", {}, undefined, undefined, ctx);
		expect(args).to.deep.equal([true]);
		expect(result.content[0].text).to.include("Spec Version: v1");
	});
});
