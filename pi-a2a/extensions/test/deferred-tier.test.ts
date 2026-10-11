/** Deferred-tier rollout: exposure flags + tool_search activation (ceulen pattern). */
import { expect } from "chai";
import a2aExtension from "../index.js";

function capture(withToolSearch: boolean) {
  const tools: any[] = [];
  const handlers: Record<string, Array<(...a: any[]) => any>> = {};
  let active: string[] = ["read", "bash"];
  const pi: any = {
    registerTool: (t: any) => tools.push(t),
    registerCommand: () => {},
    on: (event: string, handler: (...a: any[]) => any) => { (handlers[event] ??= []).push(handler); },
    getAllTools: () => tools.map((t) => ({ name: t.name, exposure: t.exposure })).concat(withToolSearch ? [{ name: "tool_search", exposure: "direct" }] : []),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  };
  a2aExtension(pi);
  return { tools, handlers, activeRef: () => active };
}

describe("a2a deferred tier", () => {
  it("registers the deferred set with exposure deferred", () => {
    const { tools } = capture(false);
    expect(tools.find((t) => t.name === "a2a_call")?.exposure, "a2a_call").to.equal("deferred");
    expect(tools.find((t) => t.name === "a2a_status")?.exposure, "a2a_status").to.equal("deferred");
    expect(tools.find((t) => t.name === "a2a_discover")?.exposure, "a2a_discover").to.equal("deferred");
    expect(tools.find((t) => t.name === "a2a_list")?.exposure, "a2a_list").to.equal("deferred");
    expect(tools.find((t) => t.name === "a2a_history")?.exposure, "a2a_history").to.equal("deferred");
    expect(tools.find((t) => t.name === "a2a_orchestrate")?.exposure, "a2a_orchestrate").to.equal("deferred");
    expect(tools.find((t) => t.name === "a2a_peers")?.exposure, "a2a_peers").to.equal("deferred");

  });

  it("session_start activates tool_search when registered but inactive, idempotently", () => {
    const { handlers, activeRef } = capture(true);
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.include("tool_search");
    const afterFirst = [...activeRef()];
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.deep.equal(afterFirst);
  });

  it("session_start is a no-op when tool_search is absent from the registry", () => {
    const { handlers, activeRef } = capture(false);
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef().includes("tool_search")).to.equal(false);
  });
});
