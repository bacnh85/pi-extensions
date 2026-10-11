/** Deferred-tier rollout: exposure flags + tool_search activation (ceulen pattern).
 *  fff registers its tools at session_start (like the main suite's harness). */
import { expect } from "chai";
import fffExtension from "./index";

function capture(withToolSearch: boolean) {
  const tools: any[] = [];
  const handlers: Record<string, Array<(...a: any[]) => any>> = {};
  let active: string[] = ["read", "bash"];
  const pi: any = {
    getFlag: () => undefined,
    registerFlag: () => {},
    registerTool: (t: any) => tools.push(t),
    registerCommand: () => {},
    on: (event: string, handler: (...a: any[]) => any) => { (handlers[event] ??= []).push(handler); },
    getAllTools: () => tools.map((t) => ({ name: t.name, exposure: t.exposure })).concat(withToolSearch ? [{ name: "tool_search", exposure: "direct" }] : []),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  };
  fffExtension(pi as any);
  const ctx = { cwd: process.cwd(), ui: { notify: () => {}, addAutocompleteProvider: () => {} } };
  const started = Promise.all((handlers.session_start ?? []).map((h) => h({}, ctx)));
  return { tools, handlers, activeRef: () => active, started };
}

describe("fff deferred tier", () => {
  it("registers fff_multi_grep as deferred (ffgrep/fffind direct)", async () => {
    const { tools, started } = capture(false);
    await started;
    expect(tools.find((t) => t.name === "fff_multi_grep")?.exposure, "fff_multi_grep").to.equal("deferred");
    for (const name of ["ffgrep", "fffind"]) {
      expect(tools.find((t) => t.name === name)?.exposure, name).to.equal(undefined);
    }
  });

  it("session_start activates tool_search when registered but inactive, idempotently", async () => {
    const { handlers, activeRef, started } = capture(true);
    await started;
    expect(activeRef()).to.include("tool_search");
    const afterFirst = [...activeRef()];
    for (const h of handlers.session_start ?? []) h({ reason: "new" }, { cwd: process.cwd() });
    expect(activeRef()).to.deep.equal(afterFirst);
  });

  it("session_start is a no-op when tool_search is absent from the registry", async () => {
    const { handlers, activeRef, started } = capture(false);
    await started;
    expect(activeRef().includes("tool_search")).to.equal(false);
  });
});
