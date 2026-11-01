/** Deferred-tier rollout: exposure flags + tool_search activation (ceulen pattern). */
import { expect } from "chai";
import serenaToolsExtension from "./index";
import { SERENA_FIRST_GUIDANCE } from "./lib/guidance";

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
  serenaToolsExtension(pi);
  return { tools, handlers, activeRef: () => active };
}

describe("serena deferred tier", () => {
  it("registers the deferred set with exposure deferred", () => {
    const { tools } = capture(false);
    expect(tools.find((t) => t.name === "serena_find_symbol")?.exposure, "serena_find_symbol").to.equal("deferred");
    expect(tools.find((t) => t.name === "serena_status")?.exposure, "serena_status").to.equal("deferred");

  });

  it("session_start activates tool_search when registered but inactive, idempotently", () => {
    const { handlers, activeRef } = capture(true);
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.include("tool_search");
    expect(activeRef()).to.not.include("serena_find_symbol");
    const afterFirst = [...activeRef()];
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.deep.equal(afterFirst);
  });

  it("session_start activates the deferred serena set directly when tool_search is absent", async () => {
    const { handlers, activeRef } = capture(false);
    for (const h of handlers.session_start ?? []) await h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.include("serena_find_symbol");
    expect(activeRef()).to.include("serena_status");
    for (const h of handlers.session_start ?? []) await h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.deep.equal(Array.from(new Set(activeRef())));
  });

  it("PI_SERENA_DIRECT_ACTIVATE=0 disables the direct-activation fallback", async () => {
    process.env.PI_SERENA_DIRECT_ACTIVATE = "0";
    try {
      const { handlers, activeRef } = capture(false);
      for (const h of handlers.session_start ?? []) await h({ reason: "new" }, { cwd: process.cwd() });
      expect(activeRef()).to.not.include("serena_find_symbol");
      expect(activeRef()).to.not.include("tool_search");
    } finally {
      delete process.env.PI_SERENA_DIRECT_ACTIVATE;
    }
  });

  it("guidance injects after fallback activation (issue #49)", async () => {
    const { handlers } = capture(false);
    for (const h of handlers.session_start ?? []) await h({ reason: "new" }, { cwd: process.cwd() });
    let result = { systemPrompt: "base" };
    for (const h of handlers.before_agent_start ?? []) {
      const r = await h({ systemPrompt: "base" }, { cwd: process.cwd() });
      if (r && r.systemPrompt) result = r;
    }
    expect(result.systemPrompt).to.include(SERENA_FIRST_GUIDANCE);
  });
});
