import { describe, it } from "mocha";
import { expect } from "chai";
import piWindowsToolsExtension from "../index";

function fakePi() {
  const tools: any[] = [];
  const commands: string[] = [];
  const hooks: string[] = [];
  return { tools, commands, hooks, api: { registerTool: (tool: any) => tools.push(tool), registerCommand: (name: string) => commands.push(name), on: (name: string) => hooks.push(name) } };
}

describe("extension registration", () => {
  it("does not register when disabled", () => {
    const old = process.env.PI_WINDOWS_TOOLS_ENABLED;
    process.env.PI_WINDOWS_TOOLS_ENABLED = "false";
    const f = fakePi();
    piWindowsToolsExtension(f.api as any);
    expect(f.tools).to.have.length(0);
    expect(f.commands).to.have.length(0);
    process.env.PI_WINDOWS_TOOLS_ENABLED = old;
  });

  it("does not execute a dangerous command when confirmation is denied", async () => {
    const old = process.env.PI_WINDOWS_TOOLS_ENABLED;
    delete process.env.PI_WINDOWS_TOOLS_ENABLED;
    const f = fakePi();
    piWindowsToolsExtension(f.api as any);
    const tool = f.tools.find(tool => tool.name === "windows_shell_exec");
    const result = await tool.execute("id", { command: "npm publish" }, new AbortController().signal, undefined, { cwd: process.cwd(), hasUI: true, ui: { select: async () => "Deny" } });
    expect(result.content[0].text).to.equal("Command cancelled by user.");
    process.env.PI_WINDOWS_TOOLS_ENABLED = old;
  });

  it("'Allow for this session' suppresses the prompt for the same executable", async () => {
    const old = process.env.PI_WINDOWS_TOOLS_ENABLED;
    delete process.env.PI_WINDOWS_TOOLS_ENABLED;
    const f = fakePi();
    piWindowsToolsExtension(f.api as any);
    const tool = f.tools.find(tool => tool.name === "windows_shell_exec");
    // Dangerous read-ish command (npm publish is confirm-risk) that fails fast on exec —
    // we only care that the SECOND call skips the prompt entirely.
    let prompts = 0;
    const ctx = { cwd: process.cwd(), hasUI: true, ui: { select: async () => { prompts++; return "Allow for this session"; } } };
    await tool.execute("id", { command: "npm publish" }, new AbortController().signal, undefined, ctx as any);
    await tool.execute("id", { command: "npm publish --tag next" }, new AbortController().signal, undefined, ctx as any);
    expect(prompts).to.equal(1);
    process.env.PI_WINDOWS_TOOLS_ENABLED = old;
  });

  it("interpreter-wrapped commands are keyed by full command, not interpreter (review fix)", async () => {
    const old = process.env.PI_WINDOWS_TOOLS_ENABLED;
    delete process.env.PI_WINDOWS_TOOLS_ENABLED;
    const f = fakePi();
    piWindowsToolsExtension(f.api as any);
    const tool = f.tools.find(tool => tool.name === "windows_shell_exec");
    let prompts = 0;
    const ctx = { cwd: process.cwd(), hasUI: true, ui: { select: async () => { prompts++; return "Allow for this session"; } } };
    // Two DIFFERENT destructive payloads behind the same interpreter: the second must still prompt.
    await tool.execute("id", { command: "powershell -Command \"git reset --hard\"" }, new AbortController().signal, undefined, ctx as any);
    await tool.execute("id", { command: "powershell -Command \"Remove-Item -Recurse -Force C:\\tmp\"" }, new AbortController().signal, undefined, ctx as any);
    expect(prompts).to.equal(2);
    process.env.PI_WINDOWS_TOOLS_ENABLED = old;
  });
});
