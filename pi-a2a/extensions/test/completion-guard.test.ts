/// Regression test (round-2 review): `a2a-send` getArgumentCompletions must
/// return null — not throw — before the first session_start has captured a
/// context (hot-reload / fresh registration), and produce peer entries after
/// one has fired. Guards the `if (!lastA2aCtx) return null;` line in index.ts.
import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import a2aExtension from "../index.js";
import { makeTempDir } from "./tmp.js";

interface CommandDef {
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Minimal stub of the pi ExtensionAPI surface used at registration time. */
function stubPi() {
  const commands = new Map<string, CommandDef>();
  const handlers = new Map<string, ((...a: unknown[]) => unknown)[]>();
  const pi = {
    registerMessageRenderer: () => {},
    registerTool: () => {},
    registerCommand: (name: string, def: CommandDef) => {
      commands.set(name, def);
    },
    on: (event: string, fn: (...a: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
  };
  return { pi, commands, handlers };
}

describe("a2a-send completion guard (lastA2aCtx)", () => {
  const dirs: string[] = [];
  const savedPiDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedPiDir;
  });

  it("returns null before any session_start (no throw), peer entries after", async () => {
    const dir = makeTempDir("pi-a2a-guard-");
    dirs.push(dir);
    process.env.PI_CODING_AGENT_DIR = dir; // isolate from the operator's ~/.pi

    const { pi, commands, handlers } = stubPi();
    a2aExtension(pi as never);

    const cmd = commands.get("a2a-send");
    expect(cmd, "a2a-send command registered").to.exist;
    expect(cmd!.getArgumentCompletions, "command exposes completions").to.be.a("function");

    // BEFORE any session_start: guard must return null, not throw
    // (cfgFor(undefined) would throw without the guard).
    expect(cmd!.getArgumentCompletions!("")).to.equal(null);

    // Fire session_start with a ctx that carries a configured peer.
    const ctx = {
      cwd: dir,
      hasUI: true,
      mode: "host",
      settings: { a2a: { peers: { alpha: { url: "http://127.0.0.1:9901" } } } },
    };
    for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);

    const items = cmd!.getArgumentCompletions!("") as { value: string }[];
    expect(items, "completions produce entries after session_start").to.be.an("array").with.lengthOf(1);
    expect(items[0]!.value).to.equal("alpha");
  });
});
