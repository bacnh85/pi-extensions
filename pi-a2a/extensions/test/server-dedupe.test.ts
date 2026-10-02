import { assert } from "chai";
import { createServer } from "node:http";

import { DEFAULTS } from "./helpers";
import { makeTempDir } from "./tmp";
import { A2AServer, type SessionRunner } from "../lib/server";
import type { A2AConfig } from "../lib/config";
import { STATE_COMPLETED } from "../lib/protocol";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

async function start(cfg: A2AConfig, runner: SessionRunner) {
  const port = await freePort();
  const c = { ...cfg, server: { ...cfg.server, port } };
  const server = new A2AServer({ cfg: c, cwd: makeTempDir("pi-a2a-dd-cwd-"), piDir: makeTempDir("pi-a2a-dd-"), runner });
  const info = await server.start();
  return { url: info.url, stop: () => server.stop() };
}

async function send(url: string, messageId: string | undefined, text = "hi", method = "SendMessage", extra: any = {}) {
  const message: any = { role: "ROLE_USER", parts: [{ text, mediaType: "text/plain" }] };
  if (messageId !== undefined) message.messageId = messageId;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(extra.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { message, ...(extra.params ?? {}) } }),
  });
  return r.json();
}

describe("server: messageId dedupe (idempotent SendMessage)", () => {
  it("a repeated messageId returns the ORIGINAL task and does not run the runner again", async () => {
    let runs = 0;
    const { url, stop } = await start(DEFAULTS(), async () => ({ reply: `run ${++runs}`, inputRequired: false }));
    try {
      const a = await send(url, "mid-1");
      const b = await send(url, "mid-1");
      assert.equal(runs, 1);
      assert.equal(a.result.task.id, b.result.task.id);
      assert.equal(b.result.task.status.state, STATE_COMPLETED);
      assert.equal(b.result.task.artifacts[0].parts[0].text, "run 1");
    } finally {
      await stop();
    }
  });

  it("a duplicate that arrives while the first is still RUNNING waits for the same run", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { url, stop } = await start(DEFAULTS(), async () => {
      runs++;
      await gate;
      return { reply: "done", inputRequired: false };
    });
    try {
      const p1 = send(url, "mid-slow");
      await new Promise((r) => setTimeout(r, 50));
      const p2 = send(url, "mid-slow"); // e.g. sender timed out and retried
      await new Promise((r) => setTimeout(r, 50));
      release();
      const [a, b] = await Promise.all([p1, p2]);
      assert.equal(runs, 1);
      assert.equal(a.result.task.id, b.result.task.id);
    } finally {
      await stop();
    }
  });

  it("different messageIds, and requests without a messageId, each start their own task (unchanged behavior)", async () => {
    let runs = 0;
    const { url, stop } = await start(DEFAULTS(), async () => ({ reply: `r${++runs}`, inputRequired: false }));
    try {
      await send(url, "a");
      await send(url, "b");
      await send(url, undefined);
      await send(url, undefined);
      assert.equal(runs, 4);
    } finally {
      await stop();
    }
  });

  it("dedupeTtlSec 0 disables dedupe (pre-0.8 behavior: every SendMessage runs)", async () => {
    let runs = 0;
    const cfg = DEFAULTS();
    cfg.server.dedupeTtlSec = 0;
    const { url, stop } = await start(cfg, async () => ({ reply: `r${++runs}`, inputRequired: false }));
    try {
      await send(url, "same");
      await send(url, "same");
      assert.equal(runs, 2);
    } finally {
      await stop();
    }
  });

  it("entries expire after the TTL", async () => {
    let runs = 0;
    const cfg = DEFAULTS();
    cfg.server.dedupeTtlSec = 1;
    const { url, stop } = await start(cfg, async () => ({ reply: `r${++runs}`, inputRequired: false }));
    try {
      await send(url, "ttl");
      await new Promise((r) => setTimeout(r, 1150));
      await send(url, "ttl");
      assert.equal(runs, 2);
    } finally {
      await stop();
    }
  });

  it("is scoped per caller identity: another caller reusing the id gets its own task", async () => {
    let runs = 0;
    const cfg = DEFAULTS();
    cfg.server.peerTokens = { alice: "tok-alice", bob: "tok-bob" };
    cfg.server.trustedPeers = ["alice", "bob"];
    const { url, stop } = await start(cfg, async () => ({ reply: `r${++runs}`, inputRequired: false }));
    try {
      const a = await send(url, "shared-id", "hi", "SendMessage", { headers: { Authorization: "Bearer tok-alice" } });
      const b = await send(url, "shared-id", "hi", "SendMessage", { headers: { Authorization: "Bearer tok-bob" } });
      const a2 = await send(url, "shared-id", "hi", "SendMessage", { headers: { Authorization: "Bearer tok-alice" } });
      assert.equal(runs, 2);
      assert.notEqual(a.result.task.id, b.result.task.id);
      assert.equal(a.result.task.id, a2.result.task.id);
    } finally {
      await stop();
    }
  });

  it("works for the pre-1.0 message/send alias (bare Task result)", async () => {
    let runs = 0;
    const { url, stop } = await start(DEFAULTS(), async () => ({ reply: `r${++runs}`, inputRequired: false }));
    try {
      const a = await send(url, "legacy", "hi", "message/send");
      const b = await send(url, "legacy", "hi", "message/send");
      assert.equal(runs, 1);
      assert.equal(a.result.id, b.result.id);
    } finally {
      await stop();
    }
  });

  it("a detached (returnImmediately) retry gets the same in-progress task, not a second run", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { url, stop } = await start(DEFAULTS(), async () => {
      runs++;
      await gate;
      return { reply: "bg", inputRequired: false };
    });
    try {
      const params = { configuration: { returnImmediately: true } };
      const a = await send(url, "bg-1", "hi", "SendMessage", { params });
      const b = await send(url, "bg-1", "hi", "SendMessage", { params });
      release();
      assert.equal(runs, 1);
      assert.equal(a.result.task.id, b.result.task.id);
    } finally {
      await stop();
    }
  });
});
