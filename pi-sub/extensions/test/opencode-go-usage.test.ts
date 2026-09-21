import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fetchOpenCodeGoUsage, opcWindowToUsageWindow } from "../index.ts";

const AUTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sub-opc-test-"));
const AUTH_PATH = path.join(AUTH_DIR, "auth.json");
const AUTH_ENV = process.env.PI_CODING_AGENT_DIR;

before(() => {
  process.env.PI_CODING_AGENT_DIR = AUTH_DIR;
});

after(() => {
  if (AUTH_ENV === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = AUTH_ENV;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
});

const REAL_FETCH = globalThis.fetch;
function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => responder(String(url), init)) as typeof fetch;
}

function writeAuth(entry: unknown): void {
  fs.writeFileSync(AUTH_PATH, JSON.stringify({ "opencode-go": entry }));
}

const LIVE_BODY = {
  usage: {
    rolling: { status: "ok", percent: 1, resetsAt: "2026-09-13T10:42:47.510Z" },
    weekly: { status: "ok", percent: 39, resetsAt: "2026-09-14T00:00:00.510Z" },
    monthly: { status: "ok", percent: 80, resetsAt: "2026-09-26T09:38:03.000Z" },
  },
};

// Live shape verified 2026-09-21 via GET /zen/go/v1/usage (paseo #4779,
// opencode-bar PR #154): percent = used 0-100, resetsAt = ISO 8601.
test("opc window parser maps the live response shape", () => {
  const w = opcWindowToUsageWindow({ status: "ok", percent: 39, resetsAt: "2026-09-14T00:00:00.510Z" });
  assert.ok(w);
  assert.equal(w.percent, 39);
  assert.equal(w.remaining, 61);
  assert.equal(typeof w.resetLabel, "string");
  assert.ok((w.resetLabel ?? "").length > 0);
});

test("opc parser clamps remaining to 0-100 on out-of-range percent", () => {
  // Undocumented API: percent is not guaranteed in 0-100.
  assert.equal(opcWindowToUsageWindow({ percent: 100 })?.remaining, 0);
  assert.equal(opcWindowToUsageWindow({ percent: -5 })?.remaining, 100);
  assert.equal(opcWindowToUsageWindow({ percent: 150 })?.remaining, 0);
});

test("opc parser skips windows with no numeric percent", () => {
  assert.equal(opcWindowToUsageWindow(undefined), undefined);
  assert.equal(opcWindowToUsageWindow({ status: "limited" }), undefined);
  assert.equal(opcWindowToUsageWindow({ percent: "39" as unknown as number }), undefined);
});

function assertAuthOnly(snapshot: Awaited<ReturnType<typeof fetchOpenCodeGoUsage>>) {
  assert.equal(snapshot.error, undefined);
  const account = snapshot.activeAccount;
  assert.ok(account);
  assert.ok(account.accountLabel);
  assert.equal(account.fiveHour, undefined);
  assert.equal(account.weekly, undefined);
  assert.equal(account.monthly, undefined);
}

test("fetch maps the live response to rolling/weekly/monthly windows", async () => {
  writeAuth({ type: "api", key: "sk-test" });
  let authHeader: string | undefined;
  mockFetch((_url, init) => {
    authHeader = (init?.headers as Record<string, string>)?.Authorization;
    return new Response(JSON.stringify(LIVE_BODY), { status: 200 });
  });
  try {
    const snapshot = await fetchOpenCodeGoUsage();
    assert.equal(authHeader, "Bearer sk-test");
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.activeAccount?.fiveHour?.remaining, 99);
    assert.equal(snapshot.activeAccount?.weekly?.remaining, 61);
    assert.equal(snapshot.activeAccount?.monthly?.remaining, 20);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("keyless accountId-only auth keeps the auth-only snapshot (session cost path)", async () => {
  writeAuth({ type: "api", accountId: "acc-123" });
  try {
    const snapshot = await fetchOpenCodeGoUsage();
    assertAuthOnly(snapshot);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("fetch failure falls back to auth-only snapshot instead of an empty error", async () => {
  // Reviewer regression 0.1.46: the error branch renders only
  // "Sub … usage unavailable", dropping the account label, session cost,
  // and tok/s that the 0.1.44 footer always showed.
  writeAuth({ type: "api", key: "sk-test" });
  mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const snapshot = await fetchOpenCodeGoUsage();
    assertAuthOnly(snapshot);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("HTTP 401 falls back to auth-only snapshot (redaction keeps auth details out)", async () => {
  writeAuth({ type: "api", key: "sk-test" });
  mockFetch(() => new Response("unauthorized", { status: 401 }));
  try {
    assertAuthOnly(await fetchOpenCodeGoUsage());
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("all-empty windows error the footer (shape drift signal)", async () => {
  writeAuth({ type: "api", key: "sk-test" });
  mockFetch(() => new Response(JSON.stringify({ usage: {} }), { status: 200 }));
  try {
    const snapshot = await fetchOpenCodeGoUsage();
    assert.ok(snapshot.error);
    assert.match(snapshot.error, /OpenCode Go/);
    assert.equal(snapshot.accounts.length, 0);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});
