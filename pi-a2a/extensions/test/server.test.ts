import { assert } from "chai";
import * as fs from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULTS } from "./helpers";
import { A2AServer, type SessionRunner } from "../lib/server";
import { STATE_CANCELED, STATE_COMPLETED, STATE_FAILED, STATE_INPUT_REQUIRED, STATE_REJECTED } from "../lib/protocol";
import { authenticate } from "../lib/security";
import { metrics } from "../lib/client";
import { list as listRegistry } from "../lib/registry";
import { setGatewayRegistrationName, getGatewayCallerName, gatewayKeyFromUrl } from "../lib/config";

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

    it("#9: strips enriched session metadata from the card for anonymous (unauthenticated) callers", async () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "test-shared-token";
      const { url, stop } = await startServer({ cfg });
      try {
        // Anonymous (no Authorization header) → plain card, no metadata.
        const anon = await (await fetch(url + ".well-known/agent-card.json")).json();
        assert.equal(anon.metadata, undefined);
        assert.equal(anon.capabilities.extensions, undefined);
        // Authenticated → enriched card with pi-session metadata.
        const auth = await (await fetch(url + ".well-known/agent-card.json", {
          headers: { Authorization: "Bearer test-shared-token" },
        })).json();
        assert.notEqual(auth.metadata, undefined);
        assert.equal(auth.metadata.extension, "https://bacnh85.dev/a2a/extensions/pi-session/v1");
      } finally {
        await stop();
      }
    });

    it("#9: /metrics requires authentication", async () => {
      const cfg = DEFAULTS();
      cfg.server.sharedToken = "test-shared-token";
      const { url, stop } = await startServer({ cfg });
      try {
        const anon = await fetch(url + "metrics");
        assert.equal(anon.status, 401);
        const auth = await fetch(url + "metrics", {
          headers: { Authorization: "Bearer test-shared-token" },
        });
        assert.equal(auth.status, 200);
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

    it("rejects a non-loopback Host in localhost-only mode (DNS-rebinding guard)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        // Node's fetch() forbids the Host header, so use raw http.request —
        // this is exactly how a DNS-rebinding attack presents itself.
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Host: "evil.example.com", // attacker domain resolving to 127.0.0.1
            },
          }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end(JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "SendMessage",
            params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } },
          }));
        });
        assert.equal(status, 403, "non-loopback Host must be rejected");
      } finally {
        await stop();
      }
    });

    it("rejects a non-loopback Origin (CSRF guard)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example.com",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "SendMessage",
            params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } },
          }),
        });
        assert.equal(resp.status, 403, "non-loopback Origin must be rejected");
      } finally {
        await stop();
      }
    });

    it("rejects browser simple-request content-types (text/plain CSRF body)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "SendMessage",
            params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } },
          }),
        });
        assert.equal(resp.status, 415, "text/plain must be rejected");
      } finally {
        await stop();
      }
    });

    it("accepts a bracketed IPv6 loopback Host [::1] (no false-positive 403)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        // Server binds 127.0.0.1; we send a bracketed-IPv6 Host header over that
        // connection — this exercises the header parser, exactly where the old
        // split(":")[0] bug lived ([::1]:port → "[" → false 403).
        const status = await new Promise<number>((resolve, reject) => {
          const u = new URL(url);
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port: u.port,
              method: "POST",
              path: "/",
              headers: { "Content-Type": "application/json", Host: `[::1]:${u.port}` },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } } }));
        });
        assert.equal(status, 200, "[::1]:port Host must be recognized as loopback, not 403");
      } finally {
        await stop();
      }
    });

    it("applies the Host gate to GET requests too (agent card via rebinding domain → 403)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const u = new URL(url);
          const req = httpRequest(
            { host: "127.0.0.1", port: u.port, method: "GET", path: "/.well-known/agent-card.json", headers: { Host: "evil.example.com" } },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.on("error", reject);
          req.end();
        });
        assert.equal(status, 403, "GET with non-loopback Host must be rejected");
      } finally {
        await stop();
      }
    });

    it("rejects Origin: null (sandboxed iframe) with 403", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "null" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } } }),
        });
        assert.equal(resp.status, 403, "Origin: null must be rejected");
      } finally {
        await stop();
      }
    });

    it("keeps working with application/json + loopback Host/Origin (no regression)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("ok") });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        assert.isUndefined(r.error, "loopback request must still pass");
        assert.equal(r.result.status.state, STATE_COMPLETED);
      } finally {
        await stop();
      }
    });
  });

  describe("outbound reply redaction", () => {
    it("redacts credential-shaped strings from the reply artifact", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("key is sk-test-abcdEFGH01234567JKLM and ghp_ABCDEFGHIJKLMNOPQRST and mytest@example.com") });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "show secrets" }] },
        });
        const text = r.result.artifacts?.[0]?.parts?.[0]?.text ?? "";
        assert.notInclude(text, "sk-test-abcdEFGH01234567JKLM", "sk-* must be redacted");
        assert.notInclude(text, "ghp_ABCDEFGHIJKLMNOPQRST", "ghp_* must be redacted");
        assert.notInclude(text, "mytest@example.com", "email must be redacted");
        assert.include(text, "[redacted]", "redaction placeholder present");
      } finally {
        await stop();
      }
    });

    it("leaves plain replies unchanged (no over-redaction)", async () => {
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner: stubRunner("hello world") });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        const text = r.result.artifacts?.[0]?.parts?.[0]?.text ?? "";
        assert.equal(text, "hello world");
      } finally {
        await stop();
      }
    });

    it("redacts the failure message too (error text can embed reply content)", async () => {
      // Runner throws an error whose message embeds a credential-shaped string —
      // the FAILED task's status.message must be scrubbed before tasks/get or
      // SSE returns it to a peer.
      const runner: SessionRunner = async () => {
        throw new Error("tool failed: token sk-abcdEFGHIJKL0123456789 leaked in payload");
      };
      const { url, stop } = await startServer({ cfg: DEFAULTS(), runner });
      try {
        const r = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "hi" }] },
        });
        assert.equal(r.result.status.state, STATE_FAILED);
        const msg = r.result.status.message?.parts?.[0]?.text ?? "";
        assert.notInclude(msg, "sk-abcdEFGHIJKL0123456789", "failure message must be redacted");
        assert.include(msg, "[redacted]", "redaction placeholder present");
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

    it("#10: tasks are per-identity — another peer cannot get/list/cancel them", async () => {
      const cfg = DEFAULTS();
      cfg.server.peerTokens = { alice: "tok-alice", bob: "tok-bob" };
      const { url, stop } = await startServer({ cfg, runner: stubRunner("secret result") });
      const aliceH = { Authorization: "Bearer tok-alice" };
      const bobH = { Authorization: "Bearer tok-bob" };
      try {
        const send = await jsonRpc(url, "SendMessage", {
          message: { role: "ROLE_USER", parts: [{ text: "alice task" }] },
        }, aliceH);
        const tid = send.result.id;
        // Bob cannot fetch Alice's task or see it in his list.
        const foreignGet = await jsonRpc(url, "tasks/get", { id: tid }, bobH);
        assert.equal(foreignGet.error?.code, -32001, "foreign tasks/get must fail");
        const bobList = await jsonRpc(url, "tasks/list", {}, bobH);
        assert.equal(bobList.result.tasks.length, 0, "tasks/list must only show own tasks");
        const foreignCancel = await jsonRpc(url, "tasks/cancel", { id: tid }, bobH);
        assert.equal(foreignCancel.error?.code, -32001, "foreign tasks/cancel must fail");
        // Alice still can.
        const ownGet = await jsonRpc(url, "tasks/get", { id: tid }, aliceH);
        assert.equal(ownGet.result.id, tid);
        const aliceList = await jsonRpc(url, "tasks/list", {}, aliceH);
        assert.equal(aliceList.result.tasks.length, 1);
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
      setGatewayRegistrationName(null);
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
      // The resolved registration name is NOT published when the gateway is
      // unreachable — a caller name must not be advertised before a
      // successful register (X-Gateway-Caller producer side).
      const key = gatewayKeyFromUrl("http://127.0.0.1:9920");
      assert.isNull(getGatewayCallerName(key), "no registration name while registration failed");
      await server.stop();
      // Registration is attempted (POST /register) even though the gateway is
      // unreachable. The reverse channel only opens AFTER a successful
      // register, so with a failing stub there is no /channel call yet — the
      // enabled:false test above proves the gate itself is what suppresses
      // every call.
      const urls = calls.map((c) => c.url);
      assert.ok(urls.some((u) => u.includes("/register")), "register attempted: " + urls.join(", "));
    });

    it("registers to EACH enabled gateway in the gateways map (0.6.0)", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.gateways = {
        work: { enabled: true, url: "http://127.0.0.1:9920", token: "x" },
        lab: { enabled: true, url: "http://127.0.0.1:9921", token: "y" },
        off: { enabled: false, url: "http://127.0.0.1:9922", token: "z" },
      };
      const port = await freePort();
      cfg.server = { ...cfg.server, port };
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      await server.start();
      await server.stop();
      const urls = calls.map((c) => c.url);
      // 2 enabled gateways → 2 POST /register attempts (the DELETE-on-stop
      // calls carry ?name= and must not count); disabled one skipped.
      const posts = urls.filter((u) => u.includes("/register") && !u.includes("?name="));
      assert.equal(posts.length, 2, urls.join(", "));
      assert.ok(posts.some((u) => u.includes("9920")), "work gateway registered");
      assert.ok(posts.some((u) => u.includes("9921")), "lab gateway registered");
      assert.ok(!urls.some((u) => u.includes("9922")), "disabled gateway must not be touched");
    });

    it("mints a per-session upstream_token and accepts it inbound (no explicit upstreamToken)", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.gateway = { enabled: true, url: "http://127.0.0.1:9920", token: "x" };
      const port = await freePort();
      cfg.server = { ...cfg.server, port };
      const piDir = tmpDir();
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir, runner: stubRunner("ok") });
      await server.start();
      // Register body must carry a minted agw-* upstream_token.
      const post = calls.find((c) => (c.init as any)?.method === "POST");
      const body = JSON.parse(String(post?.init?.body ?? "{}"));
      assert.match(String(body.upstream_token), /^agw-/);
      // The minted token authenticates inbound (extraTokens path) WITHOUT
      // flipping cfg.server.peerTokens (localhostOnly must stay untouched).
      const minted = (server as any).mintedInboundTokens[String(body.name)] as string;
      assert.equal(minted, body.upstream_token);
      assert.equal(Object.keys(cfg.server.peerTokens).length, 0, "peerTokens config untouched");
      assert.equal(
        authenticate({ authHeader: `Bearer ${minted}`, clientIp: "127.0.0.1", peerTokens: {}, sharedToken: "", extraTokens: (server as any).mintedInboundTokens }),
        String(body.name),
      );
      // No-token loopback deployment stays anonymous-friendly: absent bearer
      // still authenticates as ip: (minted map alone must not require a token).
      assert.match(
        String(authenticate({ authHeader: null, clientIp: "127.0.0.1", peerTokens: {}, sharedToken: "", extraTokens: (server as any).mintedInboundTokens })),
        /^ip:/,
      );
      await server.stop();
    });

    it("two unnamed gateway entries mint DISTINCT tokens, both authenticate inbound", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.gateways = {
        work: { enabled: true, url: "http://127.0.0.1:9920", token: "x" },
        lab: { enabled: true, url: "http://127.0.0.1:9921", token: "y" },
      };
      const port = await freePort();
      cfg.server = { ...cfg.server, port };
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      await server.start();
      // Both entries share the auto-name base-port — tokens must still differ.
      const posts = calls.filter((c) => (c.init as any)?.method === "POST" && String(c.url).includes("/register"));
      const tokens = posts.map((c) => JSON.parse(String(c.init?.body ?? "{}")).upstream_token as string);
      assert.equal(tokens.length, 2);
      assert.notEqual(tokens[0], tokens[1], "per-gateway tokens must not collide");
      const minted = (server as any).mintedInboundTokens as Record<string, string>;
      // Same peer name → last mint wins the name→token identity, but BOTH
      // tokens authenticate (identity = the name either way).
      for (const t of tokens) {
        assert.isString(
          authenticate({ authHeader: `Bearer ${t}`, clientIp: "10.0.0.9", peerTokens: {}, sharedToken: "", extraTokens: minted }),
          `token ${t} must authenticate`,
        );
      }
      await server.stop();
    });

    it("two gateways pinned to the SAME name mint distinct keys — both authenticate", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.gateways = {
        work: { enabled: true, url: "http://127.0.0.1:9920", token: "x", name: "pi" },
        lab: { enabled: true, url: "http://127.0.0.1:9921", token: "y", name: "pi" },
      };
      const port = await freePort();
      cfg.server = { ...cfg.server, port };
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      await server.start();
      const minted = (server as any).mintedInboundTokens as Record<string, string>;
      const keys = Object.keys(minted);
      assert.equal(keys.length, 2, "both minting entries retain their token");
      assert.notEqual(minted[keys[0]!], minted[keys[1]!]);
      for (const k of keys) {
        assert.isString(
          authenticate({ authHeader: `Bearer ${minted[k]}`, clientIp: "10.0.0.9", peerTokens: {}, sharedToken: "", extraTokens: minted }),
          `token for ${k} must authenticate`,
        );
      }
      await server.stop();
    });

    it("keeps an explicitly-pinned upstreamToken untouched", async () => {
      const cfg = DEFAULTS();
      cfg.discovery.gateway = { enabled: true, url: "http://127.0.0.1:9920", token: "x", upstreamToken: "pinned-tok" };
      const port = await freePort();
      cfg.server = { ...cfg.server, port };
      const server = new A2AServer({ cfg, cwd: tmpDir(), piDir: tmpDir(), runner: stubRunner("ok") });
      await server.start();
      const post2 = calls.find((c) => (c.init as any)?.method === "POST");
      const body = JSON.parse(String(post2?.init?.body ?? "{}"));
      assert.equal(body.upstream_token, "pinned-tok");
      await server.stop();
    });
  });
});
