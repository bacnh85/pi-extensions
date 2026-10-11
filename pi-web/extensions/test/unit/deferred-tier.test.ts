/** Deferred-tier rollout: exposure flags + tool_search activation (ceulen pattern). */
import { expect } from "chai";
import piWebExtension from "../../index";

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
  piWebExtension(pi);
  return { tools, handlers, activeRef: () => active };
}

describe("web deferred tier", () => {
  it("registers map/crawl/pdf/research/image/chat/status as deferred, search/extract direct", () => {
    const { tools } = capture(false);
    for (const name of ["web_map", "web_crawl", "web_pdf", "web_research", "web_image", "web_chat", "web_status"]) {
      expect(tools.find((t) => t.name === name)?.exposure, name).to.equal("deferred");
    }
    for (const name of ["web_search", "web_extract"]) {
      expect(tools.find((t) => t.name === name)?.exposure, name).to.equal(undefined);
    }
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
