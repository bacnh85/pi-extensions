import assert from "node:assert/strict";
import test from "node:test";

import budgetExtension, { parseBudgetCap } from "../index.js";

function createPiHarness(flagValue) {
  const events = new Map();
  const appendedEntries = [];
  const statusCalls = [];

  const pi = {
    registerFlag(name, options) {
      pi.flags.set(name, options);
    },
    flags: new Map(),
    getFlag(name) {
      return name === "budget" ? flagValue : undefined;
    },
    on(eventName, handler) {
      events.set(eventName, handler);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    setStatus(key, text) {
      statusCalls.push({ key, text });
    },
  };

  budgetExtension(pi);
  return { events, appendedEntries, statusCalls };
}

function createCtx(overrides = {}) {
  let aborted = false;
  const notifyCalls = [];
  const ctx = {
    aborted: () => aborted,
    notifyCalls,
    ui: {
      notify(message, type) {
        if (overrides.notifyThrows) throw new Error("notify boom");
        notifyCalls.push({ message, type });
      },
      setStatus(key, text) {
        if (overrides.statusThrows) throw new Error("status boom");
        overrides.setStatus?.(key, text);
      },
      theme: overrides.theme ?? { fg: (color, line) => `${color}:${line}` },
    },
    abort() {
      if (overrides.abortThrows) throw new Error("abort boom");
      aborted = true;
    },
  };
  return ctx;
}

function assistantMsg(costTotal, id) {
  return {
    id,
    role: "assistant",
    usage: { cost: { total: costTotal } },
  };
}

test("parseBudgetCap accepts plain decimals, rejects junk and alternate notations", () => {
  assert.equal(parseBudgetCap("0.50"), 0.5);
  assert.equal(parseBudgetCap("5"), 5);
  assert.equal(parseBudgetCap(" 1.25 "), 1.25, "whitespace trimmed");
  assert.equal(parseBudgetCap(undefined), undefined);
  assert.equal(parseBudgetCap(null), undefined);
  assert.equal(parseBudgetCap(""), undefined);
  assert.equal(parseBudgetCap("   "), undefined);
  // Review: typos / alternate notations must NOT silently become a different cap.
  assert.equal(parseBudgetCap("5 USD"), undefined, "currency suffix rejected");
  assert.equal(parseBudgetCap("0,50"), undefined, "European decimal rejected");
  assert.equal(parseBudgetCap("1e3"), undefined, "scientific notation rejected");
  assert.equal(parseBudgetCap("0x10"), undefined, "hex rejected");
  assert.equal(parseBudgetCap("Infinity"), undefined);
  assert.equal(parseBudgetCap("NaN"), undefined);
  assert.equal(parseBudgetCap("0"), undefined);
  assert.equal(parseBudgetCap("-1"), undefined);
});

test("warns when a non-empty --budget value cannot be parsed", () => {
  const { events } = createPiHarness("5 USD");
  const ctx = createCtx();
  events.get("session_start")({}, ctx);
  assert.equal(ctx.notifyCalls.length, 1, "user is warned");
  assert.match(ctx.notifyCalls[0].message, /Invalid --budget value "5 USD"/);

  // Enforcement is (correctly) disabled, but the user knows.
  events.get("message_end")({ message: assistantMsg(9) }, ctx);
  assert.equal(ctx.aborted(), false);
});

test("no warning when no flag is set", () => {
  const { events } = createPiHarness(undefined);
  const ctx = createCtx();
  events.get("session_start")({}, ctx);
  assert.equal(ctx.notifyCalls.length, 0);
});

test("aborts when cumulative cost crosses the cap", () => {
  const { events, appendedEntries } = createPiHarness("1.00");
  const ctx = createCtx();
  events.get("session_start")({}, ctx);

  events.get("message_end")({ message: assistantMsg(0.6, "m1") }, ctx);
  assert.equal(ctx.aborted(), false, "below cap: no abort");

  events.get("message_end")({ message: assistantMsg(0.5, "m2") }, ctx);
  assert.equal(ctx.aborted(), true, "crossed cap: abort");
  assert.equal(ctx.notifyCalls.length, 1);
  assert.match(ctx.notifyCalls[0].message, /Budget cap reached/);
  assert.deepEqual(appendedEntries, [
    { customType: "budget-exceeded", data: { cap: 1, spent: 1.1 } },
  ]);
});

test("aborts exactly once, not on every subsequent message", () => {
  const { events } = createPiHarness("0.50");
  const ctx = createCtx();
  events.get("session_start")({}, ctx);

  events.get("message_end")({ message: assistantMsg(0.6, "m1") }, ctx);
  events.get("message_end")({ message: assistantMsg(0.1, "m2") }, ctx);
  events.get("message_end")({ message: assistantMsg(0.1, "m3") }, ctx);
  assert.equal(ctx.aborted(), true);
  assert.equal(ctx.notifyCalls.length, 1, "one notification only");
});

test("no abort when no budget flag is set", () => {
  const { events } = createPiHarness(undefined);
  const ctx = createCtx();
  events.get("session_start")({}, ctx);

  events.get("message_end")({ message: assistantMsg(5, "m1") }, ctx);
  assert.equal(ctx.aborted(), false);
  assert.equal(ctx.notifyCalls.length, 0);
});

test("ignores non-assistant messages", () => {
  const { events } = createPiHarness("0.10");
  const ctx = createCtx();
  events.get("session_start")({}, ctx);

  events.get("message_end")({ message: { role: "user", usage: { cost: { total: 5 } } } }, ctx);
  assert.equal(ctx.aborted(), false, "user message cost ignored");
});

test("reset on session_start gives a fresh budget", () => {
  const { events } = createPiHarness("0.50");
  const ctx = createCtx();
  events.get("session_start")({}, ctx);
  events.get("message_end")({ message: assistantMsg(0.6, "m1") }, ctx);
  assert.equal(ctx.aborted(), true);

  // New session: state resets, can spend again.
  const ctx2 = createCtx();
  events.get("session_start")({}, ctx2);
  events.get("message_end")({ message: assistantMsg(0.3, "m2") }, ctx2);
  assert.equal(ctx2.aborted(), false);
});

test("footer shows remaining budget when cap set, hides when not", () => {
  const statusCalls = [];
  const { events } = createPiHarness("1.00");
  const ctx = createCtx({ setStatus: (key, text) => statusCalls.push({ key, text }) });
  events.get("session_start")({}, ctx);

  events.get("message_end")({ message: assistantMsg(0.25, "m1") }, ctx);
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].key, "pi-budget");
  assert.match(statusCalls[0].text, /Budget \$0\.25 \/ \$1\.00/);

  // No cap → clears status.
  const { events: eventsNoCap } = createPiHarness(undefined);
  const ctxNoCap = createCtx({ setStatus: (key, text) => statusCalls.push({ key, text }) });
  eventsNoCap.get("session_start")({}, ctxNoCap);
  eventsNoCap.get("message_end")({ message: assistantMsg(0.25, "m2") }, ctxNoCap);
  assert.equal(statusCalls[statusCalls.length - 1].text, undefined);
});

// ── Review-fix regression tests ────────────────────────────────────────────

test("string or NaN cost cannot poison the accumulator (review: HIGH)", () => {
  const { events } = createPiHarness("1.00");
  const ctx = createCtx();
  events.get("session_start")({}, ctx);

  // String cost: must be coerced to a number, not string-concatenated.
  events.get("message_end")({ message: assistantMsg("0.05", "m1") }, ctx);
  // NaN cost: skipped entirely.
  events.get("message_end")({ message: assistantMsg(NaN, "m2") }, ctx);
  // After a NaN, a valid cost still accumulates and can trigger abort.
  events.get("message_end")({ message: assistantMsg(0.97, "m3") }, ctx);
  assert.equal(ctx.aborted(), true, "NaN did not poison the accumulator");
});

test("abort still fires when notify throws (review: MEDIUM)", () => {
  const { events, appendedEntries } = createPiHarness("0.50");
  const ctx = createCtx({ notifyThrows: true });
  events.get("session_start")({}, ctx);

  events.get("message_end")({ message: assistantMsg(0.6, "m1") }, ctx);
  assert.equal(ctx.aborted(), true, "abort fired despite notify throwing");
  assert.equal(appendedEntries.length, 1, "entry still recorded");
});

test("handler does not throw when theme is unavailable (review: MEDIUM)", () => {
  const { events } = createPiHarness("0.50");
  const ctx = createCtx({ theme: undefined, statusThrows: true });
  events.get("session_start")({}, ctx);

  assert.doesNotThrow(() => {
    events.get("message_end")({ message: assistantMsg(0.6, "m1") }, ctx);
  });
  assert.equal(ctx.aborted(), true, "abort still works without a theme");
});

test("cost is idempotent per message id (review: LOW)", () => {
  const { events } = createPiHarness("1.00");
  const ctx = createCtx();
  events.get("session_start")({}, ctx);

  // Same message id fired twice (retry/replay) → counted once.
  events.get("message_end")({ message: assistantMsg(0.6, "same") }, ctx);
  events.get("message_end")({ message: assistantMsg(0.6, "same") }, ctx);
  // A different message with the same cost pushes over the cap only once.
  events.get("message_end")({ message: assistantMsg(0.5, "other") }, ctx);
  assert.equal(ctx.aborted(), true);
  assert.equal(ctx.notifyCalls.length, 1);
  assert.equal(ctx.notifyCalls[0].message.includes("1.10"), true, "cost is 0.6+0.5, not double-counted");
});

test("enforces even when message_end fires before session_start (review: LOW)", () => {
  const { events } = createPiHarness("0.50");
  const ctx = createCtx();

  // No session_start fired yet — lazy init reads the flag.
  events.get("message_end")({ message: assistantMsg(0.6, "m1") }, ctx);
  assert.equal(ctx.aborted(), true, "lazy init enforced the cap");
});
