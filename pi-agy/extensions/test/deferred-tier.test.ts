/** Deferred-tier rollout: exposure flags + tool_search activation (ceulen pattern). */
import { expect } from "chai";

function capture(withToolSearch: boolean, ext: (pi: any) => void) {
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
  ext(pi);
  return { tools, handlers, activeRef: () => active };
}

describe("agy deferred tier", () => {
  it("registers the agy_execute tool with exposure deferred", async () => {
    const { default: ext } = await import("../index.js");
    const { tools } = capture(false, ext);
    expect(tools.find((t) => t.name === "agy_execute")?.exposure, "agy_execute").to.equal("deferred");
  });

  it("session_start activates tool_search when registered but inactive, idempotently", async () => {
    const { default: ext } = await import("../index.js");
    const { handlers, activeRef } = capture(true, ext);
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.include("tool_search");
    const afterFirst = [...activeRef()];
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.deep.equal(afterFirst);
  });

  it("session_start is a no-op when tool_search is absent from the registry", async () => {
    const { default: ext } = await import("../index.js");
    const { handlers, activeRef } = capture(false, ext);
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef().includes("tool_search")).to.equal(false);
  });
});
