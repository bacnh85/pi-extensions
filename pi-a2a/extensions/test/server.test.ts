import { assert } from "chai";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULTS } from "./helpers";
import { A2AServer, type SessionRunner } from "../lib/server";
import { STATE_CANCELED, STATE_COMPLETED, STATE_FAILED, STATE_INPUT_REQUIRED, STATE_REJECTED } from "../lib/protocol";
import { metrics } from "../lib/client";
import { list as listRegistry } from "../lib/registry";

// ---------------------------------------------------------------------------
// Stub session runner — returns a canned reply without spawning a real agent.
// ---------------------------------------------------------------------------

function stubRunner(reply = "canned reply"): SessionRunner {
  return async () => ({ reply, inputRequired: false });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-a2a-server-"));
}

/** Pick an ephemeral free port. */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:http");
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        reject(new Error("no port"));
      }
    });
  });
}

async function startServer(opts: { cfg: typeof DEFAULTS extends infer T ? any : any; runner?: SessionRunner; piDir?: string; cwd?: string; onActivity?: (a: any) => void }): Promise<{
  server: A2AServer;
  url: string;
  stop: () => Promise<void>;
}> {
  const port = await freePort();
  const cfg = { ...opts.cfg };
  cfg.server = { ...cfg.server, port };
  const piDir = opts.piDir ?? tmpDir();
  const server = new A2AServer({
    cfg,
    cwd: opts.cwd ?? tmpDir(),
    piDir,
    runner: opts.runner ?? stubRunner(),
    onActivity: opts.onActivity,
  });
  const info = await server.start();
  return { server, url: info.url, stop: () => server.stop() };
}

async function jsonRpc(url: string, method: string, params: any, headers: Record<string, string> = {}): Promise<any> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return resp.json();
}

describe("server", () => {
  beforeEach(() => metrics.reset());

  describe("Agent Card", () => {
    it("serves a v1.0 card at the canonical path", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS() });
      try {
        const resp = await fetch(url + ".well-known/agent-card.json");
        const card = await resp.json();
        assert.equal(card.version, "1.0.0");
        assert.equal(card.supportedInterfaces[0]?.protocolBinding, "JSONRPC");
        assert.include(card.url, url);
      } finally {
        await stop();
      }
    });

    it("also serves the legacy agent.json alias", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS() });
      try {
        const resp = await fetch(url + ".well-known/agent.json");
        assert.equal(resp.status, 200);
        const card = await resp.json();
        assert.equal(card.version, "1.0.0");
      } finally {
        await stop();
      }
    });
  });

  describe("session discovery (0.2.0)", () => {
    it("registers itself in the local file registry on start", async () => {
      const piDir = tmpDir();
      const cwd = "/test-repo";
      const { server, stop } = await startServer({ cfg: DEFAULTS(), piDir, cwd });
      try {
        // The server uses process.pid as the registry key — which is alive.
        const entries = listRegistry({ piDir, ttlSec: 60 });
        const self = entries.find((e) => e.pid === process.pid);
        assert.isOk(self, "server should have registered its own pid");
        assert.equal(self!.cwd, cwd);
        assert.equal(self!.port, server.port);
      } finally {
        await stop();
      }
    });

    it("unregisters from the registry on stop", async () => {
      const piDir = tmpDir();
      const { stop } = await startServer({ cfg: DEFAULTS(), piDir });
      await stop();
      const entries = listRegistry({ piDir, ttlSec: 60 });
      const self = entries.find((e) => e.pid === process.pid);
      assert.isUndefined(self, "registry entry should be removed on stop");
    });

    it("enriches the Agent Card with session metadata when enrichCard is on", async () => {
      const cfg = DEFAULTS();
      const cwd = "/enriched-repo";
      const { url, stop } = await startServer({ cfg, cwd });
      try {
        const resp = await fetch(url + ".well-known/agent-card.json");
        const card = await resp.json();
        assert.isDefined(card.capabilities.extensions, "card should declare the extension");
        assert.isDefined(card.metadata, "card should carry metadata");
        assert.equal(card.metadata.cwd, cwd);
        assert.equal(card.metadata.pid, process.pid);
      } finally {
        await stop();
      }
    });

    it("omits metadata from the card when enrichCard is off", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.enrichCard = false;
      const { url, stop } = await startServer({ cfg });
      try {
        const resp = await fetch(url + ".well-known/agent-card.json");
        const card = await resp.json();
        assert.isUndefined(card.metadata);
        assert.isUndefined(card.capabilities.extensions);
      } finally {
        await stop();
      }
    });

    it("does NOT write a registry file when local discovery is disabled", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.local.enabled = false;
      const piDir = tmpDir();
      const { stop } = await startServer({ cfg, piDir });
      try {
        const entries = listRegistry({ piDir, ttlSec: 60 });
        assert.lengthOf(entries, 0, "no registry file should be written");
      } finally {
        await stop();
      }
    });
  });

  describe("auth gate", () => {
    it("passes in localhost-only mode (no token)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        assert.isUndefined(r.error, "no auth error");
        assert.equal(r.result.status.state, STATE_COMPLETED);
      } finally {
        await stop();
      }
    });

    it("rejects 401 when a token is set but not presented", async () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "secret";
      const { url, stop } = await startServer({ cfg, runner: stubRunner("ok") });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        assert.equal(r.error?.code, -32050, "unauthorized");
      } finally {
        await stop();
      }
    });

    it("accepts the correct token", async () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "secret";
      const { url, stop } = await startServer({ cfg, runner: stubRunner("ok") });
      try {
        const r = await jsonRpc(
          url,
          "SendMessage",
          { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } },
          { Authorization: "Bearer secret" },
        );
        assert.isUndefined(r.error);
        assert.equal(r.result.status.state, STATE_COMPLETED);
      } finally {
        await stop();
      }
    });
  });

  describe("task lifecycle", () => {
    it("runs the session and returns a COMPLETED task with the reply artifact", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("the real reply") });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "do something" }] },
        });
        const task = r.result;
        assert.equal(task.status.state, STATE_COMPLETED);
        assert.deepEqual(task.artifacts?.[0]?.parts?.[0], { text: "the real reply", mediaType: "text/plain" });
        assert.match(task.id, /^task-/);
        assert.match(task.contextId, /^ctx-/);
      } finally {
        await stop();
      }
    });

    it("maps an INPUT_REQUIRED reply", async () => {
      const runner: SessionRunner = async () => ({ reply: "what exactly?", inputRequired: true });
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        assert.equal(r.result.status.state, STATE_INPUT_REQUIRED);
      } finally {
        await stop();
      }
    });

    it("accepts the pre-1.0 message/send alias", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("legacy ok") });
      try {
        const r = await jsonRpc(url, "message/send", {
          message: { role: "user", parts: [{ text: "hi", mediaType: "text/plain" }] },
        });
        assert.equal(r.result.status.state, STATE_COMPLETED);
      } finally {
        await stop();
      }
    });

    it("tasks/get retrieves a created task, tasks/list lists them", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("x") });
      try {
        const send = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        const tid = send.result.id;
        const got = await jsonRpc(url, "tasks/get", { id: tid });
        assert.equal(got.result.id, tid);
        const list = await jsonRpc(url, "tasks/list", {});
        assert.isAtLeast(list.result.tasks.length, 1);
      } finally {
        await stop();
      }
    });

    it("tasks/get on an unknown id returns TaskNotFoundError", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS() });
      try {
        const r = await jsonRpc(url, "tasks/get", { id: "nope" });
        assert.equal(r.error?.code, -32001);
      } finally {
        await stop();
      }
    });
  });

  describe("inbound activity (0.3.0)", () => {
    it("emits arrived → progress → completed for a successful task", async () => {
      const events: any[] = [];
      const runner: SessionRunner = async ({ onProgress }) => {
        onProgress?.("⚙ bash npm test");
        return { reply: "all good", inputRequired: false };
      };
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner, onActivity: (a) => events.push(a) });
      try {
        await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "run tests" }] },
        });
        const types = events.map((e) => e.type);
        assert.deepEqual(types, ["arrived", "progress", "completed"]);
        assert.equal(events[0]!.identity, "ip:127.0.0.1"); // localhost-only mode
        assert.match(events[0]!.text, /run tests/);
        assert.match(events[1]!.line, /npm test/);
        assert.match(events[2]!.replyPreview, /all good/);
        assert.equal(events[2]!.state, STATE_COMPLETED);
      } finally {
        await stop();
      }
    });

    it("emits failed with the error when the runner throws", async () => {
      const events: any[] = [];
      const runner: SessionRunner = async () => {
        throw new Error("kaboom");
      };
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner, onActivity: (a) => events.push(a) });
      try {
        await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "boom" }] },
        });
        const types = events.map((e) => e.type);
        assert.deepEqual(types, ["arrived", "failed"]);
        assert.match(events[1]!.error, /kaboom/);
      } finally {
        await stop();
      }
    });

    it("emits completed (canceled) for a user cancel", async () => {
      const events: any[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const runner: SessionRunner = async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error("aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          void gate.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        return { reply: "never", inputRequired: false };
      };
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner, onActivity: (a) => events.push(a) });
      try {
        const sendP = jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        // Let the task start, then cancel it.
        await new Promise((r) => setTimeout(r, 50));
        const tasks = await jsonRpc(url, "tasks/list", {});
        const tid = tasks.result.tasks[0]!.id;
        await jsonRpc(url, "tasks/cancel", { id: tid });
        await sendP;
        const types = events.map((e) => e.type);
        assert.deepEqual(types, ["arrived", "completed"]);
        assert.equal(events[1]!.state, STATE_CANCELED);
      } finally {
        release();
        await stop();
      }
    });

    it("does not crash without an onActivity handler (backward compat)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        assert.equal(r.result.status.state, STATE_COMPLETED);
      } finally {
        await stop();
      }
    });
  });

  describe("anti-loop", () => {
    it("rejects after the per-context turn cap", async () => {
      const cfg = DEFAULTS();
      cfg.server.maxPingpongTurns = 2;
      const { url, stop } = await startServer({ cfg, runner: stubRunner("ok") });
      try {
        // Send twice with the same contextId — allowed.
        const r1 = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "t1" }], contextId: "ctx-loop" },
        });
        assert.equal(r1.result.status.state, STATE_COMPLETED);
        const r2 = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "t2" }], contextId: "ctx-loop" },
        });
        assert.equal(r2.result.status.state, STATE_COMPLETED);
        // Third — rejected.
        const r3 = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "t3" }], contextId: "ctx-loop" },
        });
        assert.equal(r3.result.status.state, STATE_REJECTED);
      } finally {
        await stop();
      }
    });
  });

  describe("tasks/cancel on a running task", () => {
    it("cancels a running task and sets STATE_CANCELED", async () => {
      // A runner that blocks until aborted.
      const runner: SessionRunner = ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const { server, url, stop } = await startServer({ cfg: DEFAULTS(), runner });
      try {
        // Start the task (don't await — it blocks).
        const sendP = jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "long task" }] },
        });
        // Wait for it to register.
        await new Promise((r) => setTimeout(r, 150));
        // Cancel it.
        const list = await jsonRpc(url, "tasks/list", {});
        const tid = list.result.tasks[0].id;
        const cancel = await jsonRpc(url, "tasks/cancel", { id: tid });
        assert.equal(cancel.result.status.state, STATE_CANCELED);
        // The original send resolves to a CANCELED task too.
        const send = await sendP;
        assert.equal(send.result.status.state, STATE_CANCELED);
      } finally {
        await stop();
      }
    });

    it("returns TaskNotCancelable on a completed task", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("done") });
      try {
        const send = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        const tid = send.result.id;
        const cancel = await jsonRpc(url, "tasks/cancel", { id: tid });
        assert.equal(cancel.error?.code, -32002);
      } finally {
        await stop();
      }
    });
  });

  describe("maxConcurrent enforcement", () => {
    it("rejects with 503 when concurrency is exceeded", async () => {
      const runner: SessionRunner = ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const cfg = DEFAULTS();
      cfg.server.maxConcurrent = 1;
      const { server, url, stop } = await startServer({ cfg, runner });
      try {
        // Start one blocking task (don't await).
        jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "block" }] },
        });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(server.runningCount, 1);
        // Second concurrent task should be rejected.
        const r2 = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "second" }] },
        });
        assert.equal(r2.error?.code, -32053);
        assert.include(r2.error?.message ?? "", "busy");
      } finally {
        await stop();
      }
    });

    it("also enforces the cap on message/stream (no bypass)", async () => {
      const runner: SessionRunner = ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const cfg = DEFAULTS();
      cfg.server.maxConcurrent = 1;
      const { server, url, stop } = await startServer({ cfg, runner });
      try {
        // Start one blocking streaming task (don't await).
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "s1",
            method: "message/stream",
            params: { message: { role: "ROLE_USER", parts: [{ text: "block" }] } },
          }),
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(server.runningCount, 1);
        // A second message/stream should receive a busy error frame.
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "s2",
            method: "message/stream",
            params: { message: { role: "ROLE_USER", parts: [{ text: "second" }] } },
          }),
        });
        const text = await resp.text();
        const frames = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.replace(/^data:\s*/, "")));
        const errFrame = frames.find((f) => f.error);
        assert.exists(errFrame, "expected a busy error frame");
        assert.equal(errFrame.error.code, -32053);
      } finally {
        await stop();
      }
    });
  });

  describe("message/stream SSE framing", () => {
    it("emits JSON-RPC-enveloped SSE frames echoing the request id", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("streamed reply") });
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "sse-1",
            method: "message/stream",
            params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } },
          }),
        });
        const text = await resp.text();
        // Parse each data: line.
        const frames = text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => JSON.parse(l.replace(/^data:\s*/, "")));
        assert.isAtLeast(frames.length, 1, "at least one SSE frame");
        // Every frame must be a JSON-RPC 2.0 response with the echoed id.
        for (const f of frames) {
          assert.equal(f.jsonrpc, "2.0");
          assert.equal(f.id, "sse-1");
          assert.exists(f.result, "frame must have a result");
        }
        // The final statusUpdate must carry the completed task.
        const statusFrame = frames.find((f) => f.result?.statusUpdate);
        assert.equal(statusFrame?.result?.statusUpdate?.status?.state, STATE_COMPLETED);
      } finally {
        await stop();
      }
    });
  });

  describe("reply timeout classifies as FAILED (not CANCELED)", () => {
    it("times out a slow task to STATE_FAILED", async () => {
      const cfg = DEFAULTS();
      cfg.server.replyTimeoutSec = 1;
      const runner: SessionRunner = ({ signal }) =>
        new Promise((_resolve, reject) => {
          // Never resolves on its own; waits for abort (timeout), then rejects.
          signal.addEventListener("abort", () => reject(new Error("timeout")));
        });
      const { url, stop } = await startServer({ cfg, runner });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "slow" }] },
        });
        assert.equal(r.result.status.state, STATE_FAILED);
      } finally {
        await stop();
      }
    });
  });

  describe("port fallback (EADDRINUSE → next port)", () => {
    /** Pre-bind the configured port so the A2A server must fall back. */
    async function holdPort(port: number): Promise<() => Promise<void>> {
      const srv = createServer();
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, "127.0.0.1", () => resolve());
      });
      return () => new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    it("binds port+1 when the configured port is busy, and advertises it", async () => {
      const port = await freePort();
      const release = await holdPort(port); // 9910-equivalent now busy
      const cfg = DEFAULTS();
      cfg.server.port = port;
      cfg.server.portFallback = 5;
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      try {
        const info = await server.start();
        assert.equal(info.port, port + 1, "should have climbed to port+1");
        assert.equal(server.port, port + 1, "boundPort getter reflects actual");
        // The Agent Card must advertise the ACTUAL port, not the busy configured one.
        const cardResp = await fetch(info.url + ".well-known/agent-card.json");
        const card = await cardResp.json();
        assert.include(card.supportedInterfaces[0].url, `:${port + 1}`, "card advertises the fallback port");
      } finally {
        await server.stop();
        await release();
      }
    });

    it("falls back to OS-assigned port when all explicit ports are busy", async () => {
      const port = await freePort();
      const release = await holdPort(port);
      const cfg = DEFAULTS();
      cfg.server.port = port;
      cfg.server.portFallback = 0; // configured port only, then OS-assigned
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      try {
        const info = await server.start();
        assert.notEqual(info.port, port, "must NOT use the busy configured port");
        assert.isAbove(info.port, 0);
        // Card reflects the OS-assigned port.
        const cardResp = await fetch(info.url + ".well-known/agent-card.json");
        const card = await cardResp.json();
        assert.include(card.supportedInterfaces[0].url, `:${info.port}`);
      } finally {
        await server.stop();
        await release();
      }
    });

    it("binds the configured port when free (no fallback)", async () => {
      const port = await freePort();
      const cfg = DEFAULTS();
      cfg.server.port = port;
      cfg.server.portFallback = 10;
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      try {
        const info = await server.start();
        assert.equal(info.port, port, "happy path binds configured port exactly");
      } finally {
        await server.stop();
      }
    });

    it("explicit port 0 starts on an OS-assigned ephemeral port", async () => {
      const cfg = DEFAULTS();
      cfg.server.port = 0; // user explicitly wants ephemeral
      cfg.server.portFallback = 10;
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      try {
        const info = await server.start();
        assert.isAbove(info.port, 0, "must get a real ephemeral port");
        assert.notEqual(info.port, 0);
        assert.equal(server.port, info.port, "boundPort getter reflects the ephemeral port");
        const cardResp = await fetch(info.url + ".well-known/agent-card.json");
        const card = await cardResp.json();
        assert.include(card.supportedInterfaces[0].url, `:${info.port}`, "card advertises the ephemeral port");
      } finally {
        await server.stop();
      }
    });

    it("url getter returns empty after stop (no stale port)", async () => {
      const cfg = DEFAULTS();
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      await server.start();
      assert.notEqual(server.url, "");
      assert.isNotNull(server.port);
      await server.stop();
      assert.equal(server.url, "", "stopped server must not advertise a port");
      assert.isNull(server.port, "stopped server port is null");
    });
  });

  describe("gateway registration gating (0.5.0)", () => {
    let realFetch: typeof fetch;
    let calls: Array<{ url: string; init?: RequestInit }>;

    beforeEach(() => {
      realFetch = globalThis.fetch;
      calls = [];
      // Stub fetch: record every request; the gateway is never reachable.
      // Any /register or /channel attempt therefore fails (network error →
      // register() returns false silently), but we can OBSERVE the attempt.
      (globalThis as any).fetch = async (url: any, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        throw new Error("gateway unreachable (stubbed)");
      };
    });

    afterEach(() => {
      (globalThis as any).fetch = realFetch;
    });

    it("does not register when gateway.enabled is false (no fetch attempt)", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.gateway = { enabled: false, url: "http://127.0.0.1:9920", token: "x" };
      const port = await freePort();
      cfg.server = { ...cfg.server, port };
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      await server.start();
      await server.stop();
      // The gate must short-circuit BEFORE any network call: no register,
      // no channel, no directory fetch.
      assert.equal(calls.length, 0, "disabled gateway must make zero fetch calls");
    });

    it("attempts registration when gateway.enabled is true", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.gateway = { enabled: true, url: "http://127.0.0.1:9920", token: "x" };
      const port = await freePort();
      cfg.server = { ...cfg.server, port };
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      await server.start();
      await server.stop();
      // Registration is attempted (POST /register) even though the gateway is
      // unreachable. The reverse channel only opens AFTER a successful
      // register, so with a failing stub there is no /channel call yet — the
      // enabled:false test above proves the gate itself is what suppresses
      // every call.
      const urls = calls.map((c) => c.url);
      assert.ok(urls.some((u) => u.includes("/register")), "register attempted: " + urls.join(", "));
    });
  });
});
