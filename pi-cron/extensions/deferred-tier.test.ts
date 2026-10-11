/** Deferred-tier rollout: exposure flags + tool_search activation (ceulen pattern). */
import assert from "node:assert/strict";
import cronExtension from "./index";

const DEFERRED = ["cron"];

function capture(withToolSearch: boolean) {
  const tools: any[] = [];
  const handlers: Record<string, Array<(...a: any[]) => any>> = {};
  let active: string[] = ["read", "bash"];
  const pi: any = {
    registerTool: (t: any) => tools.push(t),
    registerCommand: () => {},
    registerFlag: () => {},
    sendMessage: () => {},
    on: (event: string, handler: (...a: any[]) => any) => { (handlers[event] ??= []).push(handler); },
    getAllTools: () => tools.map((t) => ({ name: t.name, exposure: t.exposure })).concat(withToolSearch ? [{ name: "tool_search", exposure: "direct" }] : []),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  };
  cronExtension(pi);
  return { tools, handlers, activeRef: () => active };
}

describe("cron deferred tier", () => {
  it("registers the cron tool with exposure deferred", () => {
    const { tools } = capture(false);
    for (const name of DEFERRED) {
      assert.equal(tools.find((t) => t.name === name)?.exposure, "deferred", name);
    }
  });

  it("session_start activates tool_search when registered but inactive, idempotently", () => {
    const { handlers, activeRef } = capture(true);
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    assert.ok(activeRef().includes("tool_search"));
    const afterFirst = [...activeRef()];
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    assert.deepEqual(activeRef(), afterFirst);
  });

  it("session_start is a no-op when tool_search is absent from the registry", () => {
    const { handlers, activeRef } = capture(false);
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    assert.equal(activeRef().includes("tool_search"), false);
  });
});
