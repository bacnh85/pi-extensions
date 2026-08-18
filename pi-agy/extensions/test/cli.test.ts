import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

import { buildAgyArgs, spawnAgy, checkAgyHealth, checkAgyConnectivity, buildAgyPrompt, detectVerifyCommand, parseJsonResponse } from "../lib/cli.js";

// ---------------------------------------------------------------------------
// buildAgyArgs — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("buildAgyArgs", () => {
  it("sends -p as the last pair of arguments", () => {
    const args = buildAgyArgs({ prompt: "do the thing", dir: "/tmp/test", timeout_ms: 60_000 });
    const pIndex = args.indexOf("-p");
    expect(pIndex).to.equal(args.length - 2);
    expect(args[args.length - 1]).to.equal("do the thing");
  });

  it("defaults to accept-edits mode", () => {
    const args = buildAgyArgs({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 });
    const modeIndex = args.indexOf("--mode");
    expect(args[modeIndex + 1]).to.equal("accept-edits");
  });

  it("accepts explicit plan mode", () => {
    const args = buildAgyArgs({ prompt: "test", mode: "plan", dir: "/tmp", timeout_ms: 60_000 });
    const modeIndex = args.indexOf("--mode");
    expect(args[modeIndex + 1]).to.equal("plan");
  });

  it("uses agy's standalone sandbox flag", () => {
    const args = buildAgyArgs({ prompt: "test", mode: "sandbox", dir: "/tmp", timeout_ms: 60_000 });
    expect(args).to.include("--sandbox");
    expect(args).not.to.include("--mode");
  });

  const models = [
    ["flash-low", "gemini-3.7-flash-low"],
    ["flash-medium", "gemini-3.7-flash-medium"],
    ["flash-high", "gemini-3.7-flash-high"],
    ["pro-low", "gemini-3.1-pro-low"],
    ["pro-high", "gemini-3.1-pro-high"],
    ["sonnet", "claude-sonnet-4-6"],
    ["opus", "claude-opus-4-6-thinking"],
    ["gpt-oss", "gpt-oss-120b-medium"],
  ] as const;

  for (const [model, displayName] of models) {
    it(`maps model: ${model} correctly`, () => {
      const args = buildAgyArgs({ prompt: "test", model, dir: "/tmp", timeout_ms: 60_000 });
      expect(args[args.indexOf("--model") + 1]).to.equal(displayName);
    });
  }

  for (const [tier, displayName] of [
    ["flash", "gemini-3.7-flash-high"],
    ["flash-lo", "gemini-3.7-flash-low"],
    ["pro", "gemini-3.1-pro-high"],
  ] as const) {
    it(`keeps legacy tier: ${tier}`, () => {
      const args = buildAgyArgs({ prompt: "test", tier, dir: "/tmp", timeout_ms: 60_000 });
      expect(args[args.indexOf("--model") + 1]).to.equal(displayName);
    });
  }

  it("prefers model over legacy tier", () => {
    const args = buildAgyArgs({ prompt: "test", model: "sonnet", tier: "pro", dir: "/tmp", timeout_ms: 60_000 });
    expect(args[args.indexOf("--model") + 1]).to.equal("claude-sonnet-4-6");
  });

  it("defaults to flash-medium when model and tier are omitted", () => {
    const args = buildAgyArgs({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 });
    expect(args[args.indexOf("--model") + 1]).to.equal("gemini-3.7-flash-medium");
  });

  it("calculates --print-timeout from timeout_ms (rounded up)", () => {
    const args = buildAgyArgs({ prompt: "test", dir: "/tmp", timeout_ms: 120_000 });
    const ptIndex = args.indexOf("--print-timeout");
    expect(args[ptIndex + 1]).to.equal("120s");
  });

  it("includes --add-dir with correct directory", () => {
    const args = buildAgyArgs({ prompt: "test", dir: "/my/project", timeout_ms: 60_000 });
    const dirIndex = args.indexOf("--add-dir");
    expect(args[dirIndex + 1]).to.equal("/my/project");
  });

  it("builds args in correct order: model, print-timeout, add-dir, mode, skip-perm, -p, prompt", () => {
    const args = buildAgyArgs({ prompt: "go", dir: "/x", timeout_ms: 30_000 });
    expect(args).to.deep.equal([
      "--model", "gemini-3.7-flash-medium",
      "--print-timeout", "30s",
      "--add-dir", "/x",
      "--mode", "accept-edits",
      "--dangerously-skip-permissions",
      "-p", "go",
    ]);
  });

  it("plan mode is read-only: no skip-permissions, JSON output", () => {
    const args = buildAgyArgs({ prompt: "p", mode: "plan", dir: "/x", timeout_ms: 30_000 });
    expect(args).to.include("--mode");
    expect(args).to.include("plan");
    expect(args).to.include("--output-format");
    expect(args).to.include("json");
    expect(args).not.to.include("--dangerously-skip-permissions");
    expect(args).not.to.include("--sandbox");
  });

  it("sandbox mode uses standalone flag + skip-permissions + JSON", () => {
    const args = buildAgyArgs({ prompt: "p", mode: "sandbox", dir: "/x", timeout_ms: 30_000 });
    expect(args).to.include("--sandbox");
    expect(args).to.include("--dangerously-skip-permissions");
    expect(args).to.include("--output-format");
    expect(args).not.to.include("--mode");
  });
});

// ---------------------------------------------------------------------------
// buildAgyPrompt / detectVerifyCommand / parseJsonResponse — pure helpers
// ---------------------------------------------------------------------------

describe("buildAgyPrompt", () => {
  it("plan: explore prefix, no verify, respects digest", () => {
    const p = buildAgyPrompt("review X", "plan", true, "npm test");
    expect(p).to.include("Explore and produce an implementation plan only; do not edit.");
    expect(p).to.include("Use compact digests, not full file contents.");
    expect(p).to.not.include("npm test"); // verify not injected in plan mode
    expect(p.endsWith("review X")).to.be.true;
  });

  it("accept-edits with verify: injects the command", () => {
    const p = buildAgyPrompt("do X", "accept-edits", false, "npm test");
    expect(p).to.include("After editing, run `npm test` and fix failures until it passes.");
    expect(p).to.not.include("compact digests");
    expect(p.endsWith("do X")).to.be.true;
  });

  it("accept-edits without verify: no command line", () => {
    const p = buildAgyPrompt("do X", "accept-edits", false, null);
    expect(p).to.equal("do X");
  });

  it("sandbox: sandbox prefix", () => {
    const p = buildAgyPrompt("do X", "sandbox", true, "npm test");
    expect(p).to.include("Work inside the sandbox");
    expect(p).to.not.include("npm test");
  });
});

describe("detectVerifyCommand", () => {
  it("returns 'npm test' when package.json has a test script", async () => {
    const tmp = await import("node:fs/promises").then((f) => f.mkdtemp("/tmp/agy-verify-"));
    await import("node:fs/promises").then((f) => f.writeFile(`${tmp}/package.json`, JSON.stringify({ scripts: { test: "mocha" } })));
    expect(await detectVerifyCommand(tmp)).to.equal("npm test");
  });

  it("returns null when package.json has no test script", async () => {
    const tmp = await import("node:fs/promises").then((f) => f.mkdtemp("/tmp/agy-verify-"));
    await import("node:fs/promises").then((f) => f.writeFile(`${tmp}/package.json`, JSON.stringify({ scripts: {} })));
    expect(await detectVerifyCommand(tmp)).to.be.null;
  });

  it("returns null when there is no package.json", async () => {
    const tmp = await import("node:fs/promises").then((f) => f.mkdtemp("/tmp/agy-verify-"));
    expect(await detectVerifyCommand(tmp)).to.be.null;
  });
});

describe("parseJsonResponse", () => {
  it("extracts .response from agy JSON output", () => {
    const raw = JSON.stringify({ status: "SUCCESS", response: "the answer\n", usage: { total_tokens: 10 } });
    expect(parseJsonResponse(raw)).to.equal("the answer\n");
  });

  it("falls back to raw text when JSON is malformed", () => {
    expect(parseJsonResponse("not json at all")).to.equal("not json at all");
  });

  it("falls back to raw when .response is missing", () => {
    const raw = JSON.stringify({ status: "SUCCESS", usage: {} });
    expect(parseJsonResponse(raw)).to.equal(raw);
  });
});

// ---------------------------------------------------------------------------
// spawnAgy — argument pass-through (stdio, signal, exit codes)
// ---------------------------------------------------------------------------

describe("spawnAgy", () => {
  let origSpawn: any;

  beforeEach(() => {
    const cp = _require("node:child_process");
    origSpawn = cp.spawn;
  });

  afterEach(() => {
    const cp = _require("node:child_process");
    cp.spawn = origSpawn;
  });

  function makeMock(opts: {
    exitCode?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  }) {
    const cp = _require("node:child_process");
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;

      process.nextTick(() => {
        if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
        if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
        if (opts.error) child.emit("error", opts.error);
        else child.emit("close", opts.exitCode !== undefined ? opts.exitCode : 0, opts.signal !== undefined ? opts.signal : null);
      });
      return child;
    } as any;
  }

  it("detaches stdin and gives agy time to flush its timeout", async () => {
    let capturedOpts: any;
    const cp = _require("node:child_process");
    cp.spawn = function (_cmd: string, _args: string[], opts: any) {
      capturedOpts = opts;
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;
      process.nextTick(() => child.emit("close", 0, null));
      return child;
    } as any;

    const ac = new AbortController();
    await spawnAgy({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 }, ac.signal);
    expect(capturedOpts.stdio).to.deep.equal(["ignore", "pipe", "pipe"]);
    expect(capturedOpts.timeout).to.equal(65_000);
  });

  it("resolves with combined stdout+stderr on success", async () => {
    makeMock({ stdout: "done", stderr: "warn: something" });
    const ac = new AbortController();
    const result = await spawnAgy({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 }, ac.signal);
    expect(result).to.include("done");
    expect(result).to.include("warn: something");
  });

  it("bounds captured output", async () => {
    makeMock({ stdout: "A".repeat(1_000_000), stderr: "B".repeat(1_000_000) });
    const result = await spawnAgy(
      { prompt: "test", dir: "/tmp", timeout_ms: 60_000 },
      new AbortController().signal,
    );
    expect(Buffer.byteLength(result)).to.be.lessThan(140_000);
  });

  it("rejects on non-zero exit with stderr detail", async () => {
    makeMock({ exitCode: 1, stderr: "some error" });
    const ac = new AbortController();
    try {
      await spawnAgy({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 }, ac.signal);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("exit");
      expect(e.message).to.include("some error");
    }
  });

  it("rejects on SIGTERM (code=null, matching real kill behavior)", async () => {
    makeMock({ exitCode: null, signal: "SIGTERM" });
    const ac = new AbortController();
    try {
      await spawnAgy({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 }, ac.signal);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("cancelled");
      expect(e.message).to.include("SIGTERM");
    }
  });

  it("rejects on timeout (code=null, signal=null)", async () => {
    makeMock({ exitCode: null, signal: null });
    const ac = new AbortController();
    try {
      await spawnAgy({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 }, ac.signal);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("cancelled");
      expect(e.message).to.include("timeout");
    }
  });

  it("rejects on ENOENT with install hint", async () => {
    const err: any = new Error("spawn ENOENT");
    err.code = "ENOENT";
    makeMock({ error: err });
    const ac = new AbortController();
    try {
      await spawnAgy({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 }, ac.signal);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("curl");
      expect(e.message).to.include("antigravity.google");
    }
  });

  it("reports an aborted spawn as cancellation", async () => {
    makeMock({ error: new Error("The operation was aborted") });
    const ac = new AbortController();
    ac.abort();
    try {
      await spawnAgy({ prompt: "test", dir: "/tmp", timeout_ms: 60_000 }, ac.signal);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.equal("agy was cancelled");
    }
  });
});

// ---------------------------------------------------------------------------
// checkAgyHealth — mocked spawn
// ---------------------------------------------------------------------------

describe("checkAgyHealth", () => {
  let origSpawn: any;

  beforeEach(() => {
    const cp = _require("node:child_process");
    origSpawn = cp.spawn;
  });

  afterEach(() => {
    const cp = _require("node:child_process");
    cp.spawn = origSpawn;
  });

  function mockSpawn(behavior: "success" | "fail" | "enoent" | "timeout") {
    const cp = _require("node:child_process");
    cp.spawn = function (_cmd: string, _args: string[], _opts: any) {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;

      if (behavior === "enoent") {
        process.nextTick(() => {
          const err: any = new Error("spawn ENOENT");
          err.code = "ENOENT";
          child.emit("error", err);
        });
      } else if (behavior === "timeout") {
        process.nextTick(() => {
          child.emit("close", null, null);
        });
      } else {
        process.nextTick(() => {
          if (behavior === "fail") child.stderr.emit("data", Buffer.from("auth error"));
          child.emit("close", behavior === "success" ? 0 : 1, null);
        });
      }
      return child;
    } as any;
  }

  it("resolves when agy --version succeeds", async () => {
    mockSpawn("success");
    await checkAgyHealth("/tmp");
  });

  it("rejects when agy --version fails", async () => {
    mockSpawn("fail");
    try {
      await checkAgyHealth("/tmp");
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("not authenticated");
    }
  });

  it("rejects with install hint when ENOENT", async () => {
    mockSpawn("enoent");
    try {
      await checkAgyHealth("/tmp");
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("curl");
    }
  });

  it("rejects with 'timed out' label when child times out (code=null)", async () => {
    mockSpawn("timeout");
    try {
      await checkAgyHealth("/tmp");
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("timed out");
      expect(e.message).not.to.include("exit null");
    }
  });

  it("accepts an AbortSignal and passes it to spawn", async () => {
    mockSpawn("success");
    const ac = new AbortController();
    await checkAgyHealth("/tmp", ac.signal);
  });
});

// ---------------------------------------------------------------------------
// checkAgyConnectivity — mocked spawn
// ---------------------------------------------------------------------------

describe("checkAgyConnectivity", () => {
  let origSpawn: any;

  beforeEach(() => {
    const cp = _require("node:child_process");
    origSpawn = cp.spawn;
  });

  afterEach(() => {
    const cp = _require("node:child_process");
    cp.spawn = origSpawn;
  });

  function mockSpawn(opts: { exitCode?: number | null; stderr?: string; error?: Error }) {
    const cp = _require("node:child_process");
    cp.spawn = function () {
      const { EventEmitter } = _require("events");
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 123;

      process.nextTick(() => {
        if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
        if (opts.error) child.emit("error", opts.error);
        else child.emit("close", opts.exitCode !== undefined ? opts.exitCode : 0, null);
      });
      return child;
    } as any;
  }

  it("resolves when agy models succeeds", async () => {
    mockSpawn({});
    await checkAgyConnectivity("/tmp");
  });

  it("rejects when agy models fails (non-zero exit)", async () => {
    mockSpawn({ exitCode: 1, stderr: "API unavailable" });
    try {
      await checkAgyConnectivity("/tmp");
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("connectivity");
      expect(e.message).to.include("API unavailable");
    }
  });

  it("rejects with 'timed out' label on timeout (code=null)", async () => {
    mockSpawn({ exitCode: null });
    try {
      await checkAgyConnectivity("/tmp");
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("timed out");
    }
  });

  it("rejects on spawn error (ENOENT)", async () => {
    const err: any = new Error("spawn ENOENT");
    err.code = "ENOENT";
    mockSpawn({ error: err });
    try {
      await checkAgyConnectivity("/tmp");
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("curl");
    }
  });

  it("accepts an AbortSignal and passes it to spawn", async () => {
    mockSpawn({});
    const ac = new AbortController();
    await checkAgyConnectivity("/tmp", ac.signal);
  });
});
