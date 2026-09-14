/**
 * Unit tests for Gemini cookie auto-refresh (lib/gemini-auth.ts) and its
 * integration with lib/gemini.ts. No network — the rotate POST is injected.
 */

import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __keepaliveDebug,
  clearCookieStore,
  cookieStoreSnapshot,
  defaultStorePath,
  ensureKeepalive,
  keepaliveOnce,
  loadCookieStore,
  refreshGeminiAuth,
  resolvePsidts,
  rotateCookies,
  saveCookieStore,
  stopKeepalive,
  defaultPost,
  type PostFn,
} from "../../lib/gemini-auth";
import {
  describeGeminiError,
  withGeminiClient,
  __resetGeminiClientCache,
  type GeminiClientLike,
} from "../../lib/gemini";

function tmpStore(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gemini-auth-test-")), "cookies.json");
}

function fakePost(
  res: { status: number; setCookie: string[] },
  capture?: { url?: string; opts?: { headers?: Record<string, string>; body?: string } },
): PostFn {
  return async (url, opts) => {
    if (capture) {
      capture.url = url;
      capture.opts = opts;
    }
    return res;
  };
}

const okPost = (ts: string, capture?: Parameters<typeof fakePost>[1]) => fakePost({ status: 200, setCookie: [`__Secure-1PSIDTS=${ts}; Path=/; Secure; HttpOnly`] }, capture);
const unauthorizedPost = () => fakePost({ status: 401, setCookie: [] });

const config = { psid: "psid-test", psidts: "env-ts", psidSource: "test", proxy: undefined };

describe("cookie store", () => {
  it("round-trips an entry and reports snapshot freshness", () => {
    const p = tmpStore();
    saveCookieStore({ psid: "a", psidts: "b", updatedAt: Date.now() }, p);
    expect(loadCookieStore(p)).to.deep.include({ psid: "a", psidts: "b" });
    const snap = cookieStoreSnapshot(p);
    expect(snap.present).to.equal(true);
    expect(snap.ageSeconds).to.be.at.least(0);
    fs.chmodSync(p, 0o600); // saveCookieStore must leave it 0600
    expect(fs.statSync(p).mode & 0o777).to.equal(0o600);
  });

  it("treats missing and corrupt files as absent, clear removes", () => {
    const p = tmpStore();
    expect(loadCookieStore(p)).to.equal(null);
    fs.writeFileSync(p, "{not json");
    expect(loadCookieStore(p)).to.equal(null);
    saveCookieStore({ psid: "a", psidts: "b", updatedAt: 1 }, p);
    clearCookieStore(p);
    expect(loadCookieStore(p)).to.equal(null);
    expect(cookieStoreSnapshot(p).present).to.equal(false);
  });

  it("honors GEMINI_WEB_COOKIE_STORE for the default path", () => {
    const old = process.env.GEMINI_WEB_COOKIE_STORE;
    process.env.GEMINI_WEB_COOKIE_STORE = "/tmp/xyz/store.json";
    expect(defaultStorePath()).to.equal("/tmp/xyz/store.json");
    if (old === undefined) delete process.env.GEMINI_WEB_COOKIE_STORE;
    else process.env.GEMINI_WEB_COOKIE_STORE = old;
  });

  it("also resolves GEMINI_WEB_COOKIE_STORE from env files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-auth-env-"));
    fs.writeFileSync(path.join(dir, ".env.local"), "GEMINI_WEB_COOKIE_STORE=/tmp/from-env-file.json\n");
    const oldCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(defaultStorePath()).to.equal("/tmp/from-env-file.json");
    } finally {
      process.chdir(oldCwd);
    }
  });
});

describe("resolvePsidts", () => {
  it("env (fresh paste) always wins over the store", () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "store-ts", updatedAt: 1 }, p);
    expect(resolvePsidts("psid-test", "env-ts", p)).to.equal("env-ts");
  });

  it("falls back to the store only when env has no TS", () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "store-ts", updatedAt: 1 }, p);
    expect(resolvePsidts("psid-test", undefined, p)).to.equal("store-ts");
  });

  it("falls back to env with no store, and passes through guest mode", () => {
    expect(resolvePsidts("psid-test", "env-ts", tmpStore())).to.equal("env-ts");
    expect(resolvePsidts(undefined, "env-ts", tmpStore())).to.equal("env-ts");
  });
});

describe("rotateCookies", () => {
  it("sends the documented request shape and parses the fresh 1PSIDTS", async () => {
    const capture: { url?: string; opts?: { headers?: Record<string, string>; body?: string } } = {};
    const r = await rotateCookies({ psid: "p1", psidts: "t1", post: okPost("fresh", capture) });
    expect(r).to.deep.include({ ok: true, psidts: "fresh" });
    expect(capture.url).to.equal("https://accounts.google.com/RotateCookies");
    expect(capture.opts?.body).to.equal('[000,"-0000000000000000000"]');
    expect(capture.opts?.headers["Content-Type"]).to.equal("application/json");
    expect(capture.opts?.headers.Origin).to.equal("https://accounts.google.com");
    expect(capture.opts?.headers["User-Agent"]).to.include("Chrome/145"); // non-browser UAs get 400
    expect(capture.opts?.headers.Cookie).to.equal("__Secure-1PSID=p1; __Secure-1PSIDTS=t1");
  });

  it("treats 400/401 as definitive but 200-no-TS and 5xx as non-stale", async () => {
    const r = await rotateCookies({ psid: "p1", post: okPost("f2") });
    expect(r.ok).to.equal(true);
    const u = await rotateCookies({ psid: "p1", post: unauthorizedPost() });
    expect(u.ok).to.equal(false);
    expect(u.stale).to.equal(true);
    expect(u.reason).to.match(/unauthorized/);
    const bad = await rotateCookies({ psid: "p1", post: fakePost({ status: 400, setCookie: [] }) });
    expect(bad.ok).to.equal(false);
    expect(bad.stale).to.equal(true);
    const none = await rotateCookies({ psid: "p1", post: fakePost({ status: 200, setCookie: ["NID=x; Path=/"] }) });
    expect(none.ok).to.equal(false);
    expect(none.stale).to.equal(undefined);
    const boom = await rotateCookies({ psid: "p1", post: fakePost({ status: 503, setCookie: [] }) });
    expect(boom.ok).to.equal(false);
    expect(boom.stale).to.equal(undefined);
    const forbidden = await rotateCookies({ psid: "p1", post: fakePost({ status: 403, setCookie: [] }) });
    expect(forbidden.ok).to.equal(false);
    expect(forbidden.stale).to.equal(undefined); // 403 = soft-block, not dead
  });

  it("marks transport errors as NOT stale", async () => {
    const r = await rotateCookies({ psid: "p1", post: async () => { throw new Error("ECONNRESET"); } });
    expect(r.ok).to.equal(false);
    expect(r.stale).to.equal(undefined);
  });
});

describe("refreshGeminiAuth", () => {
  it("persists the fresh 1PSIDTS on success", async () => {
    const p = tmpStore();
    const r = await refreshGeminiAuth(config, { post: okPost("fresh-ts"), storePath: p });
    expect(r.ok).to.equal(true);
    expect(loadCookieStore(p)).to.deep.include({ psid: "psid-test", psidts: "fresh-ts" });
  });

  it("never destroys the store on rotation failures (400/401/offline/5xx/403)", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    await refreshGeminiAuth(config, { post: unauthorizedPost(), storePath: p });
    expect(loadCookieStore(p)).to.deep.include({ psidts: "old" });

    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    await refreshGeminiAuth(config, { post: async () => { throw new Error("offline"); }, storePath: p });
    expect(loadCookieStore(p)).to.deep.include({ psidts: "old" });

    // transient 5xx must also keep the store (reviewer: stale is for definitive rejections only)
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    await refreshGeminiAuth(config, { post: fakePost({ status: 503, setCookie: [] }), storePath: p });
    expect(loadCookieStore(p)).to.deep.include({ psidts: "old" });

    // 403 is a soft-block — the newest TS must survive it
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    await refreshGeminiAuth(config, { post: fakePost({ status: 403, setCookie: [] }), storePath: p });
    expect(loadCookieStore(p)).to.deep.include({ psidts: "old" });
  });

  it("is a no-op without a psid", async () => {
    const r = await refreshGeminiAuth({ psid: undefined }, { storePath: tmpStore() });
    expect(r.ok).to.equal(false);
    expect(r.reason).to.match(/not set/);
  });
});

describe("keepaliveOnce", () => {
  it("skips the network when the store is fresh", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "recent", updatedAt: Date.now() }, p);
    let called = 0;
    const post: PostFn = async () => {
      called++;
      return { status: 200, setCookie: [] };
    };
    expect(await keepaliveOnce(config, { storePath: p, post })).to.equal(true);
    expect(called).to.equal(0);
  });

  it("rotates and persists when stale, fails but keeps the store when dead", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    expect(await keepaliveOnce(config, { storePath: p, post: okPost("new-ts") })).to.equal(true);
    expect(loadCookieStore(p)).to.deep.include({ psidts: "new-ts" });

    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    expect(await keepaliveOnce(config, { storePath: p, post: unauthorizedPost() })).to.equal(false);
    expect(loadCookieStore(p)).to.deep.include({ psidts: "old" });
  });

  it("does not skip rotation for a fresh store belonging to a DIFFERENT psid", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "old-psid", psidts: "old-ts", updatedAt: Date.now() }, p);
    let called = 0;
    const post: PostFn = async () => {
      called++;
      return { status: 200, setCookie: ["__Secure-1PSIDTS=fresh-ts; Path=/"] };
    };
    expect(await keepaliveOnce(config, { storePath: p, post })).to.equal(true);
    expect(called).to.equal(1);
    expect(loadCookieStore(p)).to.deep.include({ psid: "psid-test", psidts: "fresh-ts" });
  });
});

describe("withGeminiClient auto-heal + passive persist", () => {
  const cfg = { ...config };

  beforeEach(() => {
    __resetGeminiClientCache();
  });

  it("on AuthError: rebuild-retries once (rotation is opt-in, not auto-invoked)", async () => {
    const p = tmpStore();
    const calls: GeminiClientLike[] = [];
    const factory = () => {
      const client: GeminiClientLike = {
        ask: async () => {
          if (calls.length === 1) {
            const e = new Error("Cookies invalid.");
            e.name = "AuthError";
            throw e;
          }
          return { text: "ok" };
        },
        research: async () => ({ text: "report" }),
      };
      calls.push(client);
      return client;
    };
    const result = await withGeminiClient(cfg, (c) => c.ask!("q"), factory, { storePath: p });
    expect(result.text).to.equal("ok");
    expect(calls).to.have.length(2);
    expect(loadCookieStore(p)).to.equal(null); // no rotation → no store write
  });

  it("on persistent AuthError: rebuilds once, propagates, and never destroys the store", async () => {
    const p = tmpStore();
    saveCookieStore({ psid: "psid-test", psidts: "old", updatedAt: 1 }, p);
    const calls = { n: 0 };
    const factory: Parameters<typeof withGeminiClient>[2] = () => {
      calls.n++;
      return {
        ask: async () => {
          const e = new Error("Cookies invalid.");
          e.name = "AuthError";
          throw e;
        },
        research: async () => ({ text: "report" }),
      };
    };
    let threw: unknown;
    try {
      await withGeminiClient(cfg, (c) => c.ask!("q"), factory, { rotatePost: unauthorizedPost(), storePath: p });
    } catch (e) {
      threw = e;
    }
    expect((threw as Error).name).to.equal("AuthError");
    expect(calls.n).to.equal(2);
    expect(loadCookieStore(p)).to.deep.include({ psid: "psid-test", psidts: "old" }); // store is never destroyed
  });

  it("persists a rotated 1PSIDTS absorbed from the client jar", async () => {
    const p = tmpStore();
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "report" }),
      cookies: { "__Secure-1PSIDTS": "jar-ts" },
    } as GeminiClientLike;
    await withGeminiClient(cfg, (c) => c.ask!("q"), () => client, { storePath: p });
    expect(loadCookieStore(p)).to.deep.include({ psid: "psid-test", psidts: "jar-ts" });
  });

  it("never writes the store in guest mode", async () => {
    const p = tmpStore();
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "report" }),
      cookies: { "__Secure-1PSIDTS": "jar-ts" },
    } as GeminiClientLike;
    await withGeminiClient({ ...cfg, psid: undefined }, (c) => c.ask!("q"), () => client, { storePath: p });
    expect(loadCookieStore(p)).to.equal(null);
  });

  it("store-write failure never fails the call (best-effort persist)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-auth-ro-"));
    fs.chmodSync(dir, 0o555);
    const client: GeminiClientLike = {
      ask: async () => ({ text: "ok" }),
      research: async () => ({ text: "report" }),
      cookies: { "__Secure-1PSIDTS": "jar-ts" },
    } as GeminiClientLike;
    try {
      const r = await withGeminiClient(cfg, (c) => c.ask!("q"), () => client, { storePath: path.join(dir, "cookies.json") });
      expect(r.text).to.equal("ok");
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});

describe("describeGeminiError AuthError guidance", () => {
  it("points at the incognito re-paste and the keepalive store", () => {
    const e = new Error("Cookies invalid.");
    e.name = "AuthError";
    const msg = describeGeminiError(e);
    expect(msg).to.match(/incognito/);
    expect(msg).to.match(/daily browser/);
  });
});

describe("ensureKeepalive arming", () => {
  const OLD_KEEPALIVE = process.env.GEMINI_WEB_KEEPALIVE;
  const OLD_INTERVAL = process.env.GEMINI_WEB_ROTATE_INTERVAL_MS;

  afterEach(() => {
    stopKeepalive();
    if (OLD_KEEPALIVE === undefined) delete process.env.GEMINI_WEB_KEEPALIVE;
    else process.env.GEMINI_WEB_KEEPALIVE = OLD_KEEPALIVE;
    if (OLD_INTERVAL === undefined) delete process.env.GEMINI_WEB_ROTATE_INTERVAL_MS;
    else process.env.GEMINI_WEB_ROTATE_INTERVAL_MS = OLD_INTERVAL;
  });

  it("stays disarmed by default (rotation is opt-in)", () => {
    delete process.env.GEMINI_WEB_KEEPALIVE;
    delete process.env.GEMINI_WEB_ROTATE_INTERVAL_MS;
    ensureKeepalive(config);
    expect(__keepaliveDebug().armed).to.equal(false);
  });

  it("stays disarmed when GEMINI_WEB_KEEPALIVE=0", () => {
    process.env.GEMINI_WEB_KEEPALIVE = "0";
    ensureKeepalive(config);
    expect(__keepaliveDebug().armed).to.equal(false);
  });

  it("arms when GEMINI_WEB_KEEPALIVE=1: default 600s cadence, honors env interval, clamps below the floor", () => {
    process.env.GEMINI_WEB_KEEPALIVE = "1";
    delete process.env.GEMINI_WEB_ROTATE_INTERVAL_MS;
    ensureKeepalive(config);
    expect(__keepaliveDebug().armed).to.equal(true);
    expect(__keepaliveDebug().intervalMs).to.equal(600_000);
    stopKeepalive();
    process.env.GEMINI_WEB_ROTATE_INTERVAL_MS = "120000";
    ensureKeepalive(config);
    expect(__keepaliveDebug().intervalMs).to.equal(120_000);
    stopKeepalive();
    process.env.GEMINI_WEB_ROTATE_INTERVAL_MS = "5000";
    ensureKeepalive(config);
    expect(__keepaliveDebug().intervalMs).to.equal(600_000);
  });

  it("re-arms when the psid changes", () => {
    process.env.GEMINI_WEB_KEEPALIVE = "1";
    ensureKeepalive(config);
    expect(__keepaliveDebug().psid).to.equal("psid-test");
    ensureKeepalive({ ...config, psid: "psid-other" });
    expect(__keepaliveDebug().psid).to.equal("psid-other");
  });

  it("tick passes cfg+hooks through (post called, store written)", async function () {
    this.timeout(5000);
    process.env.GEMINI_WEB_KEEPALIVE = "1";
    const p = tmpStore();
    let called = 0;
    const post: PostFn = async () => {
      called++;
      return { status: 200, setCookie: ["__Secure-1PSIDTS=tick-ts; Path=/"] };
    };
    ensureKeepalive(config, { post, storePath: p, intervalMs: 1000 });
    await new Promise((r) => setTimeout(r, 1300));
    stopKeepalive();
    expect(called).to.be.at.least(1);
    expect(loadCookieStore(p)).to.deep.include({ psidts: "tick-ts" });
  });
});

describe('defaultPost (rotation transport)', () => {
  it('captures Set-Cookie from a redirect without following it', async function () {
    this.timeout(5000);
    const { createServer } = await import('node:http');
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      res.writeHead(302, { 'set-cookie': ['__Secure-1PSIDTS=redirect-ts; Path=/'], location: '/should-not-follow' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await defaultPost(`http://127.0.0.1:${port}/rotate`, {
        headers: { 'Content-Type': 'application/json' },
        body: '[000,"-0000000000000000000"]',
        timeoutMs: 2000,
      });
      expect(res.status).to.equal(302); // redirect NOT followed
      expect(res.setCookie.join(' ')).to.include('__Secure-1PSIDTS=redirect-ts');
      await new Promise((r2) => setTimeout(r2, 100));
      expect(hits).to.equal(1); // exactly one request
    } finally {
      server.close();
    }
  });
});
