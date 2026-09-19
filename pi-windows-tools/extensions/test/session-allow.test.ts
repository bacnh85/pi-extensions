import { describe, it } from "mocha";
import { expect } from "chai";
import piWindowsToolsExtension from "../index";

function fakePi() {
  const tools: any[] = [];
  const commands: string[] = [];
  const hooks: string[] = [];
  return { tools, commands, hooks, api: { registerTool: (tool: any) => tools.push(tool), registerCommand: (name: string) => commands.push(name), on: (name: string) => hooks.push(name) } };
}

describe("session-allow keying for destructive commands", () => {
  function setup() {
    const old = process.env.PI_WINDOWS_TOOLS_ENABLED;
    delete process.env.PI_WINDOWS_TOOLS_ENABLED;
    const f = fakePi();
    piWindowsToolsExtension(f.api as any);
    const tool = f.tools.find(tool => tool.name === "windows_shell_exec");
    let prompts = 0;
    const ctx = { cwd: process.cwd(), hasUI: true, ui: { select: async () => { prompts++; return "Allow for this session"; } } };
    // Pre-abort signal: the gate still fires, execution resolves cancelled —
    // no real process spawns (same trick as index.test.ts).
    const signal = AbortSignal.timeout(1);
    return { tool, ctx: ctx as any, signal, prompts: () => prompts, restore: () => { process.env.PI_WINDOWS_TOOLS_ENABLED = old; } };
  }

  it("approving 'rm -r build' does NOT suppress the prompt for 'rm -rf C:\\'", async () => {
    const { tool, ctx, signal, prompts, restore } = setup();
    await tool.execute("id", { command: "rm -r build" }, signal, undefined, ctx);
    await tool.execute("id", { command: "rm -rf C:\\" }, signal, undefined, ctx);
    expect(prompts()).to.equal(2);
    restore();
  });

  it("approving 'rm -r build' DOES suppress the prompt for the exact same command", async () => {
    const { tool, ctx, signal, prompts, restore } = setup();
    await tool.execute("id", { command: "rm -r build" }, signal, undefined, ctx);
    await tool.execute("id", { command: "rm -r build" }, signal, undefined, ctx);
    expect(prompts()).to.equal(1);
    restore();
  });

  it("sudo-wrapped destructive commands key by full command", async () => {
    const { tool, ctx, signal, prompts, restore } = setup();
    await tool.execute("id", { command: "sudo rm -r build" }, signal, undefined, ctx);
    await tool.execute("id", { command: "sudo rm -r build" }, signal, undefined, ctx);
    await tool.execute("id", { command: "sudo rm -rf C:\\" }, signal, undefined, ctx);
    expect(prompts()).to.equal(2);
    restore();
  });
});