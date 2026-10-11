/** Deferred-tier rollout: exposure flags + tool_search activation (ceulen pattern). */
import { expect } from "chai";
import muninExtension from "../../index";

const DEFERRED = ["munin_store", "munin_list", "munin_recent", "munin_delete", "munin_capabilities", "munin_share"];
const DIRECT = ["munin_search", "munin_get"];

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
  muninExtension(pi);
  return { tools, handlers, activeRef: () => active };
}

describe("munin deferred tier", () => {
  it("registers store/list/recent/delete/capabilities/share as deferred, search/get direct", () => {
    const { tools } = capture(false);
    for (const name of DEFERRED) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).to.exist;
      expect(tool.exposure, name).to.equal("deferred");
    }
    for (const name of DIRECT) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).to.exist;
      expect(tool.exposure, name).to.equal(undefined);
    }
  });

  it("session_start activates tool_search when registered but inactive", () => {
    const { handlers, activeRef } = capture(true);
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.include("tool_search");
  });

  it("session_start is a no-op when tool_search is already active or absent", () => {
    let { handlers, activeRef } = capture(true);
    for (const h of handlers.session_start ?? []) h({}, { cwd: process.cwd() });
    const afterFirst = [...activeRef()];
    for (const h of handlers.session_start ?? []) h({}, { cwd: process.cwd() });
    expect(activeRef()).to.deep.equal(afterFirst); // idempotent, no duplicates
    // absent: capture without tool_search in the registry → active list untouched
    ({ handlers, activeRef } = capture(false) as any);
    for (const h of handlers.session_start ?? []) h({}, { cwd: process.cwd() });
    expect(activeRef().includes("tool_search")).to.equal(false);
  });
});
