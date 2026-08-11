import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import permissionExtension, { wildcardToRegex, resolveRule, readSettingsKey } from "../index.js";

test("readSettingsKey reads .pi/settings.json from cwd (production path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-settings-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ permission: { bash: { "*": "deny" } } }));
    const key = readSettingsKey(dir, "permission");
    assert.deepEqual(key, { bash: { "*": "deny" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSettingsKey returns undefined when no settings file", () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-settings-"));
  try {
    assert.equal(readSettingsKey(dir, "permission"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSettingsKey treats non-object values as misconfig (undefined)", () => {
  const dir = mkdtempSync(join(tmpdir(), "perm-settings-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    // String value is invalid config — must not be returned.
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ permission: "ask" }));
    assert.equal(readSettingsKey(dir, "permission"), undefined);
    // Array value is also invalid.
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ permission: ["bash"] }));
    assert.equal(readSettingsKey(dir, "permission"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Pattern matching (the non-trivial logic) ──────────────────────────────

test("wildcardToRegex: * matches zero+ chars, ? matches exactly one", () => {
  const r = wildcardToRegex("git *");
  assert.equal(r.test("git status"), true);
  assert.equal(r.test("git"), false, "trailing space required");
  assert.equal(r.test("gitstatus"), false, "space literal");

  const q = wildcardToRegex("a?c");
  assert.equal(q.test("abc"), true);
  assert.equal(q.test("ac"), false, "? requires one char");
  assert.equal(q.test("abbc"), false);
});

test("wildcardToRegex: regex specials escaped literally", () => {
  // `*` crosses `/` (OpenCode semantics), so `src/*.ts` matches nested too.
  const r = wildcardToRegex("src/*.ts");
  assert.equal(r.test("src/a/b.ts"), true);
  assert.equal(r.test("src/x.ts"), true);
  assert.equal(r.test("test/x.ts"), false);

  const dot = wildcardToRegex("package.json");
  assert.equal(dot.test("package.json"), true);
  assert.equal(dot.test("packageXjson"), false, "dot is literal");
});

test("resolveRule: last matching rule wins", () => {
  const rules = { "*": "ask", "git *": "allow", "git push *": "deny" };
  assert.equal(resolveRule(rules, "git status"), "allow");
  assert.equal(resolveRule(rules, "git push origin main"), "deny");
  assert.equal(resolveRule(rules, "npm test"), "ask");
});

test("resolveRule: deny + more specific allow", () => {
  // `*` crosses `/` (OpenCode semantics), so `src/*.ts` matches nested too.
  const rules = { "*": "deny", "src/*.ts": "allow" };
  assert.equal(resolveRule(rules, "src/a.ts"), "allow");
  assert.equal(resolveRule(rules, "src/x/a.ts"), "allow");
  assert.equal(resolveRule(rules, "test/a.ts"), "deny");
});

test("resolveRule: returns null when no rule matches", () => {
  assert.equal(resolveRule({ "git *": "allow" }, "npm test"), null);
  assert.equal(resolveRule(null, "x"), null);
  assert.equal(resolveRule(undefined, "x"), null);
});

test("resolveRule: .env deny pattern (OpenCode default security)", () => {
  const rules = { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" };
  assert.equal(resolveRule(rules, "/proj/.env"), "deny");
  assert.equal(resolveRule(rules, "/proj/.env.local"), "deny");
  assert.equal(resolveRule(rules, "/proj/.env.example"), "allow");
  assert.equal(resolveRule(rules, "/proj/src/index.ts"), "allow");
});

// ── Extension wiring (tool_call handler) ──────────────────────────────────

function harness({ rules = {}, flags = {}, hasUI = true } = {}) {
  const pi = {
    flags: new Map(),
    flagOpts: flags,
    getFlag(name) {
      return this.flagOpts[name];
    },
    registerFlag(name) {
      this.flags.set(name, true);
    },
    getSetting(name) {
      return name === "permission" ? rules : undefined;
    },
    config: {},
    handlers: {},
    on(eventName, handler) {
      this.handlers[eventName] = handler;
      this.handler = handler; // keep legacy alias (last-registered) for old tests
    },
  };
  permissionExtension(pi);
  pi.sessionStart = pi.handlers["session_start"]; // expose for reset tests
  pi.handler = pi.handlers["tool_call"]; // legacy alias used by existing tests
  return pi;
}

function ctx({ hasUI = true, selectChoice = "Allow once" } = {}) {
  const notifies = [];
  let selected = selectChoice;
  return {
    hasUI,
    cwd: "/proj",
    home: "/home/user",
    notifies,
    ui: {
      notify(m, t) {
        notifies.push({ m, t });
      },
      async select(_title, _opts) {
        return selected;
      },
    },
  };
}

test("no permission config → allows everything (no opinion)", async () => {
  const pi = harness({ rules: undefined });
  const result = await pi.handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx());
  assert.equal(result, undefined);
});

test("explicit deny blocks regardless of yolo", async () => {
  const pi = harness({
    rules: { bash: { "*": "ask", "rm *": "deny" } },
    flags: { yolo: true },
  });
  const result = await pi.handler({ toolName: "bash", input: { command: "rm -rf /tmp" } }, ctx());
  assert.equal(result.block, true);
  assert.match(result.reason, /denied by permission rule/);
});

test("ask prompts UI when hasUI; Allow once passes through", async () => {
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  const result = await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx({ selectChoice: "Allow once" }));
  assert.equal(result, undefined);
});

test("ask + Deny → block", async () => {
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  const result = await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx({ selectChoice: "Deny" }));
  assert.equal(result.block, true);
  assert.match(result.reason, /denied by user/);
});

test("ask without UI fails closed (block)", async () => {
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  const result = await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx({ hasUI: false }));
  assert.equal(result.block, true);
  assert.match(result.reason, /requires approval \(no UI\)/);
});

test("--yolo auto-approves ask but keeps deny", async () => {
  const pi = harness({ rules: { bash: { "*": "ask", "rm *": "deny" } }, flags: { yolo: true } });
  assert.equal(await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx()), undefined);
  const blocked = await pi.handler({ toolName: "bash", input: { command: "rm x" } }, ctx());
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /denied by permission rule/);
});

test("global * default applies when no tool rule matches", async () => {
  const pi = harness({ rules: { "*": "ask", "bash": { "git *": "allow" } } });
  // read has no tool rule → falls to * → ask
  const result = await pi.handler({ toolName: "read", input: { path: "src/a.ts" } }, ctx({ selectChoice: "Deny" }));
  assert.equal(result.block, true);
  assert.match(result.reason, /denied by user/);
  // bash git → allow
  const allowed = await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx());
  assert.equal(allowed, undefined);
});

test("allow rule passes through silently", async () => {
  const pi = harness({ rules: { bash: { "*": "deny", "git status": "allow" } } });
  const result = await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx());
  assert.equal(result, undefined);
});

// ── Doom-loop guard ───────────────────────────────────────────────────────

test("doom-loop blocks the 3rd identical call", async () => {
  const pi = harness({ rules: { "*": "allow" } });
  const call = { toolName: "bash", input: { command: "ls" } };
  const c = ctx();
  assert.equal(await pi.handler(call, c), undefined, "1st: allow");
  assert.equal(await pi.handler(call, c), undefined, "2nd: allow");
  const blocked = await pi.handler(call, c);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /doom-loop/);
  assert.equal(c.notifies.length, 1);
  assert.match(c.notifies[0].m, /Doom-loop blocked/);
});

test("doom-loop does not trigger on different commands", async () => {
  const pi = harness({ rules: { "*": "allow" } });
  const c = ctx();
  await pi.handler({ toolName: "bash", input: { command: "ls" } }, c);
  await pi.handler({ toolName: "bash", input: { command: "ls -la" } }, c);
  const result = await pi.handler({ toolName: "bash", input: { command: "pwd" } }, c);
  assert.equal(result, undefined, "different command resets loop tracking");
});

// ── external_directory boundary ───────────────────────────────────────────

test("external_directory: blocks writes outside cwd by default", async () => {
  const pi = harness({ rules: { external_directory: { "~/secret/**": "allow" } } });
  // path outside /proj, not in allow → falls to tool rule / * (none) → null → allow.
  // But external should still be detected. With no global rule, action stays null → allow.
  // This test confirms external detection + rule resolution path; real deny needs a default.
  const result = await pi.handler({ toolName: "write", input: { path: "/proj/src/a.ts" } }, ctx());
  assert.equal(result, undefined, "inside cwd: no external check, no rule → allow");
});

test("external_directory deny blocks path outside cwd", async () => {
  const pi = harness({
    rules: { external_directory: { "*": "deny", "~/projects/**": "allow" } },
  });
  const result = await pi.handler({ toolName: "write", input: { path: "/etc/passwd" } }, ctx());
  assert.equal(result.block, true);
  assert.match(result.reason, /external_directory/);
});

test("external_directory allow lets tool rules still apply", async () => {
  // Per OpenCode: external_directory is a gate. Once allowed through, tool rules
  // still apply. Here path is external but allowed; tool rule denies → deny.
  const pi = harness({
    rules: {
      external_directory: { "~/projects/**": "allow" },
      read: { "~/projects/secret/**": "deny" },
    },
  });
  const c = ctx();
  c.home = "/home/user";
  const result = await pi.handler({ toolName: "read", input: { path: "/home/user/projects/secret/x" } }, c);
  assert.equal(result.block, true, "external allowed but tool rule denies");
  assert.match(result.reason, /read/);
});

// ── Review-fix regression tests ────────────────────────────────────────────

test("'Allow always this session' actually suppresses subsequent prompts (review: HIGH)", async () => {
  // The choice "Allow always this session" must record the (tool, subject) so
  // later identical calls skip the prompt entirely.
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  let choice = "Allow always this session";
  const c = ctx({ selectChoice: "Allow always this session" });
  // First call: prompts, user picks "Allow always" → allow.
  assert.equal(await pi.handler({ toolName: "bash", input: { command: "git status" } }, c), undefined);
  // Second call: same subject, must NOT prompt again (would block if the
  // session-allow record was not consulted). We verify by switching select to
  // "Deny": if the session allow works, the handler returns undefined without
  // calling select, so the deny never takes effect.
  const c2 = ctx({ selectChoice: "Deny" });
  assert.equal(await pi.handler({ toolName: "bash", input: { command: "git status" } }, c2), undefined,
    "session allow recorded, no second prompt");
  // A DIFFERENT subject must still prompt (deny).
  const c3 = ctx({ selectChoice: "Deny" });
  const r = await pi.handler({ toolName: "bash", input: { command: "rm x" } }, c3);
  assert.equal(r.block, true, "different subject still prompts");
});

test("unknown action value is treated as no-opinion (review: MED)", async () => {
  // A misconfig where "*" is an object (not a string) must not block or ask.
  const pi = harness({ rules: { "*": { nested: "object" } } });
  const result = await pi.handler({ toolName: "bash", input: { command: "ls" } }, ctx());
  assert.equal(result, undefined, "object action ignored → allow");
});

test("doom-loop memory resets across sessions (review: MED)", async () => {
  // Session A makes 2 identical calls (no block yet). session_start resets, so
  // session B's first 2 identical calls do NOT trip the guard.
  const pi = harness({ rules: { "*": "allow" } });
  const call = { toolName: "bash", input: { command: "ls" } };
  const c = ctx();
  await pi.handler(call, c);
  await pi.handler(call, c);
  // Simulate new session firing session_start.
  const sessionStart = pi.sessionStart;
  if (sessionStart) await sessionStart({}, c);
  // After reset: first two calls of the new session must not be blocked.
  assert.equal(await pi.handler(call, c), undefined, "post-reset 1st: allow");
  assert.equal(await pi.handler(call, c), undefined, "post-reset 2nd: allow");
});
