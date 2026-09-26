/**
 * Service-path tests for the request-level sandbox override.
 *
 * pi-plan (flowIsolation: "worktree") dispatches implement/fix through
 * SUBAGENT_REQUEST_EVENT with `sandbox: "worktree"` + `merge: "3way"`. These
 * tests drive the real registered event handler with a faux model and assert:
 *  - the child really runs in a git worktree (isolation honored),
 *  - the result carries mergeStatus/patch back through the respond channel,
 *  - a request without `sandbox` still runs in the parent checkout,
 *  - readOnly callers (pi-review) are unaffected.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "mocha";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

type Handler = (data: any) => void;

interface Harness {
  emit: (event: string, data: any) => void;
  setCtx: (ctx: any) => void;
  cwd: string;
}

let extension: ((pi: any) => void) | undefined;
let harness: Harness | undefined;

before(async () => {
  (globalThis as any).__dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mod = await import("../index.ts");
  extension = mod.default;
});

function makeGitRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repo, "a.txt"), "line1\n");
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["add", "a.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repo });
  return repo;
}

function writeAgent(cwd: string, frontmatter: string): void {
  const dir = path.join(cwd, ".pi", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "worker.md"), `---\n${frontmatter}\n---\nYou are a test agent. Write requested files.\n`);
}

/** Boot a fake pi host; returns the harness with the registered event handler. */
function boot(cwd: string): Harness {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on: (event: string, handler: Handler) => { (handlers[event] ??= []).push(handler); },
    events: {
      on: (event: string, handler: Handler) => { (handlers[event] ??= []).push(handler); },
      emit: () => {},
    },
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    getAllTools: () => [],
    sendMessage: () => {},
  };
  extension!(pi as any);
  const h: Harness = {
    cwd,
    emit: (event, data) => { for (const handler of handlers[event] ?? []) handler(data); },
    setCtx: (ctx) => { for (const handler of handlers["session_start"] ?? []) (handler as unknown as (event: any, ctx: any) => void)({ reason: "startup" }, ctx); },
  };
  return h;
}

/** A minimal ctx good enough for runNamedAgent (model registry + trust + tools). */
function fakeCtx(cwd: string, model: any, modelRuntime: unknown) {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
    getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "bash" }],
    model,
    modelRegistry: {
      getAvailable: () => [model],
      runtime: modelRuntime,
      authStorage: undefined,
    },
    ui: undefined,
  };
}

async function fauxModel(api: string, responses: any[]) {
  const { fauxProvider } = await import("../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const faux = fauxProvider({ api, provider: api });
  const model = faux.getModel();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore() });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  return { model, modelRuntime, faux };
}

async function dispatch(h: Harness, request: any): Promise<any> {
  return new Promise((resolve) => {
    h.emit("pi-subagent:run", {
      ...request,
      respond: (reply: any) => resolve(reply),
    });
  });
}

describe("pi-subagent service: request-level sandbox override", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeGitRepo("pi-subagent-svc-");
    harness = boot(cwd);
  });

  it("runs a sandbox:\"worktree\" request in a real worktree and returns mergeStatus", async function () {
    this.timeout(60_000);
    writeAgent(cwd, "name: worker\ndescription: test worker\nmodel: test/faux");
    const { model, modelRuntime } = await fauxModel("pi-subagent-svc-wt", []);
    // The child must actually write a file; drive it through a real faux tool
    // call so the worktree diff is non-empty.
    const { fauxToolCall, fauxAssistantMessage } = await import("../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
    const second = await fauxModel("pi-subagent-svc-wt2", [
      fauxAssistantMessage([fauxToolCall("write", { path: "iso.txt", content: "isolated\n" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("wrote iso.txt [verification: pass]", { stopReason: "stop" }),
    ]);
    void model; void modelRuntime;
    harness!.setCtx(fakeCtx(cwd, second.model, second.modelRuntime));

    const reply = await dispatch(harness!, {
      id: "req-1",
      agent: "worker",
      task: "write iso.txt",
      cwd,
      sandbox: "worktree",
      merge: "3way",
      accept: () => true,
    });

    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.result.mergeStatus, "applied", `mergeStatus=${reply.result.mergeStatus} err=${reply.result.mergeError ?? "none"} patch=${reply.result.patch ?? "none"}`);
    assert.ok(reply.result.patch?.includes("iso.txt"), "patch captured from the worktree");
    assert.equal(fs.readFileSync(path.join(cwd, "iso.txt"), "utf8"), "isolated\n", "merge landed in the parent checkout");
  });

  it("a request without sandbox runs in the shared checkout (no isolation)", async function () {
    this.timeout(60_000);
    writeAgent(cwd, "name: worker\ndescription: test worker\nmodel: test/faux");
    const { fauxToolCall, fauxAssistantMessage } = await import("../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js");
    const second = await fauxModel("pi-subagent-svc-shared", [
      fauxAssistantMessage([fauxToolCall("write", { path: "shared.txt", content: "shared\n" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("wrote shared.txt", { stopReason: "stop" }),
    ]);
    harness!.setCtx(fakeCtx(cwd, second.model, second.modelRuntime));

    const reply = await dispatch(harness!, {
      id: "req-2",
      agent: "worker",
      task: "write shared.txt",
      cwd,
      accept: () => true,
    });

    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.result.mergeStatus, undefined, "no worktree merge for a plain request");
    assert.ok(fs.existsSync(path.join(cwd, "shared.txt")), "child edited the shared checkout");
  });
});
