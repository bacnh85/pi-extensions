import { describe, it, before, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as path from "node:path";
import * as url from "node:url";
import { createRequire } from "node:module";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const _require = createRequire(import.meta.url);

describe("agy_execute tool integration", function () {
  this.timeout(60_000);

  let piAgyExtension: any;
  let registeredTool: any = null;

  before(async () => {
    const mod = await import("../index.js");
    piAgyExtension = mod.default;
  });

  beforeEach(() => {
    registeredTool = null;
  });

  it("registers the tool with correct metadata", () => {
    const mockPi: any = {
      registerTool(def: any) {
        registeredTool = def;
      },
    };
    piAgyExtension(mockPi);
    expect(registeredTool).to.exist;
    expect(registeredTool.name).to.equal("agy_execute");
    const params = registeredTool.parameters;
    expect(params.properties).to.have.property("prompt");
    expect(params.required).to.include("prompt");
    expect(params.properties).to.have.property("model");
    expect(params.properties).to.have.property("tier");
    expect(params.properties).to.have.property("mode");
    expect(params.properties).to.have.property("dir");
    expect(params.properties).to.have.property("digest");
    expect(params.properties).to.have.property("timeout_ms");
    expect(registeredTool.promptGuidelines).to.be.an("array").that.is.not.empty;
    const guidance = registeredTool.promptGuidelines.join(" ");
    expect(guidance).to.include("Gemini quota group");
    expect(guidance).to.include("Claude quota group");
    expect(guidance).to.include("gpt-oss");
    expect(guidance).to.include("cross-review");
  });

  describe("execute pipeline", () => {
    let mockCtx: any;
    let execute: any;
    let origSpawn: any;

    beforeEach(() => {
      const mockPi: any = {
        registerTool(def: any) {
          registeredTool = def;
        },
      };
      piAgyExtension(mockPi);
      execute = registeredTool.execute;
      mockCtx = { cwd: path.resolve(__dirname, "../../..") };
      const cp = _require("node:child_process");
      origSpawn = cp.spawn;
    });

    afterEach(() => {
      const cp = _require("node:child_process");
      cp.spawn = origSpawn;
    });

    it("defaults compact digests off for writes and on for non-write modes", async () => {
      const cp = _require("node:child_process");
      const prompts: string[] = [];
      cp.spawn = function (_cmd: string, args: string[]) {
        const { EventEmitter } = _require("events");
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(() => {
          if (!args.includes("--version") && !args.includes("models")) {
            prompts.push(args.at(-1)!);
            child.stdout.emit("data", Buffer.from("done"));
          }
          child.emit("close", 0, null);
        });
        return child;
      } as any;

      const run = (params: Record<string, unknown>) => execute(
        "test-id",
        params,
        undefined,
        undefined,
        mockCtx,
      );
      expect((await run({ prompt: "write" })).content[0].text).to.equal("done");
      expect((await run({ prompt: "review", mode: "plan" })).content[0].text).to.equal("done");
      // repo root has no package.json → no verify injection; plan gets explore+digest framing
      expect(prompts).to.deep.equal([
        "write",
        "Explore and produce an implementation plan only; do not edit.\nUse compact digests, not full file contents.\nreview",
      ]);
    });

    it("injects the verify command for accept-edits when package.json has a test script", async () => {
      const cp = _require("node:child_process");
      const fsp = _require("node:fs/promises");
      const tmp = await fsp.mkdtemp("/tmp/agy-int-");
      await fsp.writeFile(`${tmp}/package.json`, JSON.stringify({ scripts: { test: "mocha" } }));
      const prompts: string[] = [];
      cp.spawn = function (_cmd: string, args: string[]) {
        const { EventEmitter } = _require("events");
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(() => {
          if (!args.includes("--version") && !args.includes("models")) {
            prompts.push(args.at(-1)!);
            child.stdout.emit("data", Buffer.from("done"));
          }
          child.emit("close", 0, null);
        });
        return child;
      } as any;
      await execute("id", { prompt: "impl X" }, undefined, undefined, { cwd: tmp });
      expect(prompts[0]).to.equal("After editing, run `npm test` and fix failures until it passes.\nimpl X");
    });

    it("passes Claude and Gemini model aliases to agy", async () => {
      const cp = _require("node:child_process");
      const models: string[] = [];
      cp.spawn = function (_cmd: string, args: string[]) {
        const { EventEmitter } = _require("events");
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(() => {
          if (!args.includes("--version") && !args.includes("models")) {
            models.push(args[args.indexOf("--model") + 1]);
            child.stdout.emit("data", Buffer.from("done"));
          }
          child.emit("close", 0, null);
        });
        return child;
      } as any;

      for (const model of ["sonnet", "pro-low"]) {
        await execute("test-id", { prompt: "work", model }, undefined, undefined, mockCtx);
      }
      expect(models).to.deep.equal([
        "claude-sonnet-4-6",
        "gemini-3.1-pro-low",
      ]);
    });

    it("throws tool failures instead of returning successful content", async () => {
      try {
        await execute(
          "test-id",
          { prompt: "ping", dir: "missing-agy-test-directory" },
          undefined,
          undefined,
          mockCtx,
        );
        expect.fail("should have thrown");
      } catch (err) {
        // containment guard (issue #20 L3) rejects a nonexistent dir before spawn
        expect((err as Error).message).to.include("does not exist");
      }
    });

    it("issue #20 L3: rejects dir outside the workspace root", async () => {
      try {
        await execute("test-id", { prompt: "ping", dir: ".." }, undefined, undefined, mockCtx);
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("outside the workspace root");
      }
    });

    it("issue #20 L3: containment error mentions the opt-out env var", async () => {
      const outside = path.resolve(mockCtx.cwd, "..");
      try {
        await execute("test-id", { prompt: "ping", dir: outside }, undefined, undefined, mockCtx);
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("PI_AGY_ALLOW_EXTERNAL_CWD");
      }
    });

    it("truncates output over 8000 chars using mocked spawn", async () => {
      const cp = _require("node:child_process");
      const longString = "A".repeat(10000);

      cp.spawn = function (_cmd: string, _args: string[], _opts: any) {
        const { EventEmitter } = _require("events");
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 999;

        process.nextTick(() => {
          if (_args?.includes("--version") || _args?.includes("models")) {
            child.emit("close", 0, null);
          } else {
            child.stdout.emit("data", Buffer.from(longString));
            child.emit("close", 0, null);
          }
        });
        return child;
      } as any;

      const result = await execute(
        "test-id",
        { prompt: "generate long text", mode: "plan", digest: false },
        undefined,
        undefined,
        mockCtx,
      );

      const text = result.content[0].text;
      expect(text.length).to.be.lessThan(8500);
      expect(result.content[0].text).to.include("(Output truncated");
    });
  });
});

// ---------------------------------------------------------------------------
// Live smoke test — gated by AGY_LIVE=1; skipped in CI without agy installed.
// Asserts the model aliases pi-agy emits are actually accepted by the real CLI.
// ---------------------------------------------------------------------------

const LIVE = process.env.AGY_LIVE === "1";

(LIVE ? describe : describe.skip)("agy live model-name smoke", function () {
  this.timeout(180_000);
  const { execFileSync } = _require("node:child_process");
  const aliases: Record<string, string> = {
    "flash-low": "gemini-3.7-flash-low",
    "flash-medium": "gemini-3.7-flash-medium",
    "flash-high": "gemini-3.7-flash-high",
    "pro-low": "gemini-3.1-pro-low",
    "pro-high": "gemini-3.1-pro-high",
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-6-thinking",
    "gpt-oss": "gpt-oss-120b-medium",
  };

  for (const [alias, machineName] of Object.entries(aliases)) {
    it(`real agy accepts model alias ${alias} -> ${machineName}`, () => {
      // Exit 0 + non-empty output means agy recognized the model name.
      const out = execFileSync("agy", [
        "--model", machineName, "--print-timeout", "120s", "--mode", "plan",
        "-p", "Reply with exactly: OK",
      ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 150_000 });
      expect(out).to.be.a("string").that.is.not.empty;
    });
  }
});
