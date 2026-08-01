/**
 * Unit tests for pi-web before_agent_start routing-guidance injection.
 *
 * The routing protocol should be injected ONLY when a web_* tool is active,
 * so sessions without pi-web (or recon agents with no extension tools) carry
 * zero overhead. Previously this guidance was forced always-on via the global
 * AGENTS.md; now it self-injects from this extension.
 */

import { expect } from "chai";
import piWebExtension from "../../index";

function harness() {
  const tools: Record<string, any> = {};
  const handlers: Record<string, Function[]> = {};
  const pi: any = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
  };
  piWebExtension(pi);
  return { tools, handlers };
}

function callHook(handlers: Record<string, Function[]>, selectedTools: string[] | undefined) {
  return handlers.before_agent_start[0]({
    systemPrompt: "BASE",
    systemPromptOptions: { selectedTools },
  });
}

describe("pi-web before_agent_start routing guidance", () => {
  it("registers seven web_* tools", () => {
    const { tools } = harness();
    const webTools = Object.keys(tools).filter((n) => n.startsWith("web_"));
    expect(webTools).to.have.length(7);
  });

  it("injects routing guidance when a web_* tool is active", async () => {
    const { handlers } = harness();
    const result = await callHook(handlers, ["read", "web_search"]);
    expect(result.systemPrompt).to.include("BASE");
    expect(result.systemPrompt).to.include("Web Tool Routing (pi-web)");
    expect(result.systemPrompt).to.include("Firecrawl Search has poor semantic accuracy");
  });

  it("does not inject when no web_* tool is active", async () => {
    const { handlers } = harness();
    const result = await callHook(handlers, ["read", "bash", "grep"]);
    // No systemPrompt returned → undefined result keeps the prompt unchanged.
    expect(result).to.equal(undefined);
  });

  it("does not inject when selectedTools is undefined", async () => {
    const { handlers } = harness();
    const result = await callHook(handlers, undefined);
    expect(result).to.equal(undefined);
  });
});
