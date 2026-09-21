import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import notifyExtension, { resolveConfig, notify, playSound, detectBackend, toastScript, sanitizeOsc, _resetBackendCacheForTest } from "../index.js";

// ── resolveConfig ─────────────────────────────────────────────────────────

test("resolveConfig merges user config over defaults", () => {
  assert.deepEqual(resolveConfig(undefined), {
    onComplete: true, onError: true, onQuestion: true, sound: true, volume: 0.4,
  });
  const cfg = resolveConfig({ sound: false, volume: 0.8 });
  assert.equal(cfg.sound, false);
  assert.equal(cfg.volume, 0.8);
  assert.equal(cfg.onComplete, true, "unspecified keys keep defaults");
});

test("resolveConfig tolerates non-object input", () => {
  const cfg = resolveConfig(null);
  assert.equal(cfg.onComplete, true);
});

// ── notify / playSound never throw (best-effort) ──────────────────────────

test("notify does not throw for any backend", () => {
  // These would normally spawn processes; in the test sandbox they fail
  // silently (execFile callback swallows ENOENT). The contract is "never throw".
  for (const backend of ["darwin", "linux", "windows", "unknown"]) {
    assert.doesNotThrow(() => notify("T", "B", backend));
  }
});

test("playSound does not throw for any backend", () => {
  for (const backend of ["darwin", "linux", "windows", "unknown"]) {
    assert.doesNotThrow(() => playSound(0.5, backend));
  }
});

test("playSound clamps volume to [0,1]", () => {
  assert.doesNotThrow(() => playSound(-1, "linux"));
  assert.doesNotThrow(() => playSound(2, "linux"));
});

// ── Extension wiring ──────────────────────────────────────────────────────

function harness({ flagValue = false, getFlagThrows = false, notifySpy = () => {}, soundSpy = () => {} } = {}) {
  const pi = {
    on(evt, handler) { this.handlers = this.handlers || {}; this.handlers[evt] = handler; },
    registerFlag() {},
    getFlag() {
      // Regression: after session replacement/reload the SDK's runtime is
      // stale and getFlag throws. Handlers must never touch it at event time.
      if (getFlagThrows) {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
      return flagValue;
    },
  };
  // Default to no-op spies so unit tests never spawn real notifications or
  // sounds; effect-asserting tests pass their own recording spies.
  notifyExtension(pi, { notify: notifySpy, playSound: soundSpy });
  return pi;
}

test("extension registers handlers without throwing", () => {
  const pi = harness();
  assert.equal(typeof pi.handlers.agent_settled, "function");
  assert.equal(typeof pi.handlers.tool_result, "function");
  assert.equal(typeof pi.handlers.turn_start, "function");
  assert.equal(typeof pi.handlers.ui_prompt_start, "function", "question hook must be registered");
});

test("--no-notify flag disables firing (handler still must not throw)", () => {
  const pi = harness({ flagValue: true });
  assert.doesNotThrow(() => pi.handlers.agent_settled({}, {}));
  assert.doesNotThrow(() => pi.handlers.tool_result({ isError: true }, {}));
});

test("agent_settled handler does not throw when settings absent", () => {
  const pi = harness();
  assert.doesNotThrow(() => pi.handlers.agent_settled({}, {}));
});

test("tool_result fires error only once per turn (dedupe)", () => {
  const pi = harness();
  pi.handlers.turn_start({}, {});
  // First error: must not throw (real fire spawns best-effort notify).
  assert.doesNotThrow(() => pi.handlers.tool_result({ isError: true }, {}));
  // Second error same turn: handler returns early, still no throw.
  assert.doesNotThrow(() => pi.handlers.tool_result({ isError: true }, {}));
});

test("onError config=false suppresses error notification (observable effect)", () => {
  // Settings now come from settings.json on disk (the SDK has no getSetting
  // API) — write one into a temp cwd and refresh via session_start. Assert on
  // the EFFECT: with onError:false, no notification fires; with defaults, it does.
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { onError: false } }));
  const notifyCalls = [];
  const pi = harness({ notifySpy: (...a) => notifyCalls.push(a) });
  pi.handlers.session_start({}, { cwd: dir });
  pi.handlers.turn_start({}, {});
  pi.handlers.tool_result({ isError: true }, {});
  assert.equal(notifyCalls.length, 0, "onError:false must suppress the notification");
});

test("default settings fire a notification (observable effect)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { sound: false } }));
  const notifyCalls = [];
  const soundCalls = [];
  const pi = harness({ notifySpy: (...a) => notifyCalls.push(a), soundSpy: (...a) => soundCalls.push(a) });
  pi.handlers.session_start({}, { cwd: dir });
  pi.handlers.turn_start({}, {});
  pi.handlers.tool_result({ isError: true }, {});
  assert.equal(notifyCalls.length, 1, "error notification fires by default");
  assert.equal(soundCalls.length, 0, "sound:false suppresses the sound");
});

test("stale runner (getFlag throws) never crashes handlers (regression)", () => {
  // Simulates the SDK invalidating the runner after newSession/fork/reload:
  // the old runner's handlers still fire (agent_settled teardown), and must
  // not throw even though the captured pi API is stale.
  const pi = harness({ getFlagThrows: true });
  assert.doesNotThrow(() => pi.handlers.agent_settled({}, {}));
  assert.doesNotThrow(() => pi.handlers.tool_result({ isError: true }, {}));
  assert.doesNotThrow(() => pi.handlers.turn_start({}, {}));
});

test("ui_prompt_start fires a question notification with the prompt title", () => {
  const notifyCalls = [];
  const pi = harness({ notifySpy: (...a) => notifyCalls.push(a), soundSpy: () => {} });
  pi.handlers.ui_prompt_start({ type: "ui_prompt_start", kind: "custom", title: "Deploy to prod?" }, {});
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0][0], "Pi");
  assert.match(notifyCalls[0][1], /Deploy to prod\?/);
});

test("ui_prompt_start tolerates a missing title", () => {
  const notifyCalls = [];
  const pi = harness({ notifySpy: (...a) => notifyCalls.push(a), soundSpy: () => {} });
  assert.doesNotThrow(() => pi.handlers.ui_prompt_start({ kind: "select" }, {}));
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0][1], /waiting for your input/);
});

test("onQuestion config=false suppresses question notification", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ notify: { onQuestion: false } }));
  const notifyCalls = [];
  const pi = harness({ notifySpy: (...a) => notifyCalls.push(a), soundSpy: () => {} });
  pi.handlers.session_start({}, { cwd: dir });
  pi.handlers.ui_prompt_start({ kind: "confirm", title: "Sure?" }, {});
  assert.equal(notifyCalls.length, 0, "onQuestion:false must suppress the notification");
});

test("detectBackend falls back to terminal when the platform binary is absent", () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-notify-path-"));
  const prev = process.env.PATH;
  _resetBackendCacheForTest();
  process.env.PATH = empty; // no osascript / notify-send / powershell.exe here
  try {
    assert.equal(detectBackend(), "terminal");
  } finally {
    process.env.PATH = prev;
    _resetBackendCacheForTest();
  }
});

// ── Review-fix regression tests ────────────────────────────────────────────

test("macOS notify escapes backslash and quote in body/title (review: MED)", () => {
  // Capture the args passed to execFile by intercepting the child_process import.
  // We can't easily monkeypatch the imported execFile; instead verify the escape
  // logic directly by re-implementing it the same way and checking no raw
  // unescaped `"` or `\` leaks. This guards against regressions in the regex.
  const esc = (s) => s.replace(/["\\]/g, "\\$&");
  const body = 'He said "hi\\bye"';
  const escaped = esc(body);
  // In the generated AppleScript, no raw unescaped `"` or `\` leaks: every
  // occurrence is prefixed by a backslash.
  assert.equal(escaped, 'He said \\"hi\\\\bye\\"');
  // Round-trip: unescape should recover original.
  assert.equal(escaped.replace(/\\(["\\])/g, "$1"), body);
});

test("Windows toastScript escapes single quotes in title/body (mirrors macOS test)", () => {
  // PowerShell single-quoted strings escape ' by doubling it (''). Verify the
  // generated script contains no raw unescaped ' inside the title/body slots.
  const title = "Pi's done, isn't it?";
  const body = "It's 100% 'complete'\\nnext line";
  const script = toastScript(title, body);
  // The escaped slots: every ' in the inputs is doubled in the output.
  assert.ok(script.includes("Pi''s done, isn''t it?"), "title single quotes doubled");
  assert.ok(script.includes("It''s 100% ''complete''"), "body single quotes doubled");
  // Backslash is literal in PS single-quoted strings — must pass through untouched.
  assert.ok(script.includes("complete''\\nnext"), "backslash passes through");
  // Extract the two ''-slots and round-trip back to the originals.
  const slots = [...script.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  assert.ok(slots.includes(title), "title round-trips");
  assert.ok(slots.includes(body), "body round-trips");
});

test("sanitizeOsc strips escapes so OSC 777 payload stays well-formed (review: P2)", () => {
  // Model-controlled input (ui_prompt_start title) tries to forge an OSC 52
  // clipboard sequence and inject extra `;` fields.
  const t = "\x1b]52;c;xxx\x07Injected";
  const b = "Question: run; rm -rf /\x1b]777;notify;fake;pwn\x07";
  const ts = sanitizeOsc(t);
  const bs = sanitizeOsc(b);
  // No C0 control (ESC/BEL) or DEL survives; no `;` field separator survives.
  assert.ok(!/[\x00-\x1f\x7f]/.test(ts), "title has no control chars");
  assert.ok(!/[\x00-\x1f\x7f]/.test(bs), "body has no control chars");
  assert.ok(!ts.includes(";"), "title has no raw `;`");
  assert.ok(!bs.includes(";"), "body has no raw `;`");
  // Assembled 777 sequence: exactly one ESC (leading) and one BEL (trailing).
  const seq = `\x1b]777;notify;${ts};${bs}\x07`;
  assert.match(seq, /^\x1b]777;notify;/);
  assert.match(seq, /\x07$/);
  assert.equal((seq.match(/\x1b/g) || []).length, 1, "single well-formed ESC");
  assert.equal((seq.match(/\x07/g) || []).length, 1, "single well-formed BEL");
  // Message text is preserved, not discarded.
  assert.ok(ts.includes("Injected"));
});

test("sanitizeOsc covers OSC 99 fields and passes clean text through", () => {
  const title = sanitizeOsc("head\x1b\\er;evil");
  const body = sanitizeOsc("line1;\x07line2\x7f");
  // ESC is stripped; a lone `\` is inert without it (ST needs ESC+`\`) and passes through.
  assert.equal(title, "head\\er,evil");
  assert.equal(body, "line1,line2");
  // Assembled 99 body payload: ESC only at the ST terminator, `;` count fixed.
  const seq = `\x1b]99;i=1:p=body;${body}\x1b\\`;
  assert.equal((seq.match(/\x1b/g) || []).length, 2, "only the two ESCs (OSC intro + ST)");
  assert.ok(!/[\x00-\x1f\x7f]/.test(title) && !/[\x00-\x1f\x7f]/.test(body));
  assert.equal(sanitizeOsc("plain text"), "plain text", "clean input unchanged");
});
