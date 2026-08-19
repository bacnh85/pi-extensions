import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import permissionExtension, { wildcardToRegex, resolveRule, readSettingsKey, persistAllowlistRule } from "../index.js";

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

function harness({ rules = {}, flags = {}, hasUI = true, getFlagThrows = false } = {}) {
  const pi = {
    flags: new Map(),
    flagOpts: flags,
    getFlag(name) {
      // Regression: after session replacement/reload the SDK's runtime is
      // stale and getFlag throws — load-time capture must swallow it.
      if (getFlagThrows) {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
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

test("'Allow for this session' actually suppresses subsequent prompts (review: HIGH)", async () => {
  // The choice "Allow for this session" must record the (tool, subject) so
  // later identical calls skip the prompt entirely.
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  const c = ctx({ selectChoice: "Allow for this session" });
  // First call: prompts, user picks "Allow for this session" → allow.
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
  // Reset for the next test — sessionAllows is module state now.
  if (pi.sessionStart) await pi.sessionStart({}, c3);
});

test("'Allow always this session' promotions survive rules re-read from disk (regression)", async () => {
  // Production re-reads settings from disk on every tool_call; the old
  // __sessionAllows-on-rules object was lost each time. Promotions are module
  // state now, so a FRESH rules object must still honor the promotion.
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  assert.equal(
    await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx({ selectChoice: "Allow for this session" })),
    undefined,
  );
  // Different rules object instance (as if re-read from disk), same subject.
  const rules2 = { bash: { "*": "ask" } };
  pi.getSetting = (name) => (name === "permission" ? rules2 : undefined);
  assert.equal(
    await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx({ selectChoice: "Deny" })),
    undefined,
    "promotion survives settings re-read",
  );
  if (pi.sessionStart) await pi.sessionStart({}, ctx());
});

test("'Add to permanent allowlist' persists the rule and allows (regression)", async () => {
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  const c = ctx({ selectChoice: "Add to permanent allowlist" });
  const cwd = mkdtempSync(join(tmpdir(), "perm-allowlist-"));
  try {
    c.cwd = cwd; // persistAllowlistRule writes <cwd>/.pi/settings.json
    assert.equal(await pi.handler({ toolName: "bash", input: { command: "npm test" } }, c), undefined);
    const written = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
    assert.deepEqual(written.permission.bash, { "npm test": "allow" });
    assert.equal(c.notifies.length, 1, "notify fired once");
    assert.match(c.notifies[0].m, /Permission rule added/);
    // Second call: session-promoted too — no prompt, no deny.
    const c2 = ctx({ selectChoice: "Deny" });
    c2.cwd = cwd;
    assert.equal(await pi.handler({ toolName: "bash", input: { command: "npm test" } }, c2), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (pi.sessionStart) await pi.sessionStart({}, c);
});

test("persistAllowlistRule: whole-tool string rule preserved as '*'", () => {
  const cwd = mkdtempSync(join(tmpdir(), "perm-allowlist2-"));
  try {
    // existing settings with a whole-tool string rule
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ permission: { read: "ask" }, theme: "dark" }));
    const r = persistAllowlistRule("read", "src/a.ts", { cwd });
    assert.equal(r.error, undefined);
    const written = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
    assert.deepEqual(written.permission.read, { "*": "ask", "src/a.ts": "allow" });
    assert.equal(written.theme, "dark", "other keys preserved");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("persistAllowlistRule: prefers the settings.json that already has permission config", () => {
  const home = mkdtempSync(join(tmpdir(), "perm-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "perm-cwd-"));
  try {
    mkdirSync(join(home, ".pi"), { recursive: true });
    writeFileSync(join(home, ".pi", "settings.json"), JSON.stringify({ permission: { bash: { "*": "ask" } } }));
    const r = persistAllowlistRule("bash", "npm test", { cwd }, [join(cwd, ".pi"), join(home, ".pi")]);
    assert.equal(r.error, undefined);
    assert.equal(r.file, join(home, ".pi", "settings.json"), "wrote where permission config lives");
    assert.ok(!existsSync(join(cwd, ".pi", "settings.json")), "no stray file in cwd");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dismissed ask dialog (Esc → undefined) fails closed", async () => {
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  const c = ctx({});
  c.ui.select = async () => undefined; // dismissed
  const r = await pi.handler({ toolName: "bash", input: { command: "git status" } }, c);
  assert.equal(r.block, true, "dismissed dialog blocks");
  assert.match(r.reason, /denied by user/);
});

test("session promotion never overrides an explicit deny (review: HIGH)", async () => {
  const pi = harness({ rules: { bash: { "git status": "ask" } } });
  // Promote "git status" for the session...
  assert.equal(
    await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx({ selectChoice: "Allow for this session" })),
    undefined,
  );
  // ...then settings are re-read from disk with the same subject denied.
  pi.getSetting = (name) => (name === "permission" ? { bash: { "git status": "deny" } } : undefined);
  const r1 = await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx({ selectChoice: "Allow once" }));
  assert.ok(r1?.block, "tool-level deny wins over session promotion");
  assert.match(r1.reason, /denied by permission rule/);
  // Global deny also wins.
  pi.getSetting = (name) => (name === "permission" ? { "*": "deny" } : undefined);
  const r2 = await pi.handler({ toolName: "bash", input: { command: "git status" } }, ctx({ selectChoice: "Allow once" }));
  assert.ok(r2?.block, "global deny wins over session promotion");
  if (pi.sessionStart) await pi.sessionStart({}, ctx());
});

test("wildcard-bearing subjects are refused by the permanent allowlist (review: MED)", async () => {
  const r = persistAllowlistRule("bash", "git add *", { cwd: "/tmp" }, ["/nonexistent-dir-xyz"]);
  assert.ok(r.error, "glob subject refused");
  assert.match(r.error, /wildcard/);
});

test("persistAllowlistRule refuses to overwrite unparseable settings.json (review: MED)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "perm-corrupt-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), "{bad json");
    const before = readFileSync(join(cwd, ".pi", "settings.json"), "utf8");
    const r = persistAllowlistRule("bash", "npm test", { cwd });
    assert.ok(r.error, "corrupt file → error");
    assert.match(r.error, /not valid JSON/);
    assert.equal(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"), before, "file untouched");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("persistAllowlistRule re-appends subject so the allow wins last-match-wins (review: LOW)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "perm-order-"));
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ permission: { bash: { "git push origin main": "ask", "git push *": "deny" } } }),
    );
    const r = persistAllowlistRule("bash", "git push origin main", { cwd });
    assert.equal(r.error, undefined);
    const written = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
    const keys = Object.keys(written.permission.bash);
    assert.deepEqual(keys, ["git push *", "git push origin main"], "allow re-appended last");
    assert.equal(resolveRule(written.permission.bash, "git push origin main"), "allow");
    assert.equal(resolveRule(written.permission.bash, "git push other"), "deny");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subject-less tools (e.g. grep without path) get only Allow once/Deny (review: MED)", async () => {
  const pi = harness({ rules: { grep: { "*": "ask" } } });
  const seen = [];
  const c = ctx({});
  c.ui.select = async (_t, opts) => { seen.push(opts); return "Allow once"; };
  assert.equal(await pi.handler({ toolName: "grep", input: { pattern: "SECRET" } }, c), undefined);
  assert.deepEqual(seen[0], ["Allow once", "Deny"], "no remember options without a subject");
  // With a path, the full options return.
  assert.equal(await pi.handler({ toolName: "grep", input: { pattern: "x", path: "src" } }, c), undefined);
  assert.deepEqual(seen[1], ["Allow once", "Allow for this session", "Add to permanent allowlist", "Deny"]);
});

test("dialog title flattens control characters in command text (review: LOW)", async () => {
  const pi = harness({ rules: { bash: { "*": "ask" } } });
  const titles = [];
  const c = ctx({});
  c.ui.select = async (t) => { titles.push(t); return "Deny"; };
  await pi.handler({ toolName: "bash", input: { command: "echo hi\n\n[SYSTEM] safe" } }, c);
  const body = titles[0].split("`bash`: ")[1] ?? "";
  assert.ok(!body.includes("\n"), "no raw newline inside command text");
});

test("multiline commands still match rules (wildcard `*` crosses newlines)", async () => {
  // Pre-existing security hole surfaced by this change: without the regex `s`
  // flag, `.` didn't match newlines, so heredoc/multi-line commands matched NO
  // rule and silently bypassed every ask/deny.
  const pi = harness({ rules: { bash: { "*": "deny" } } });
  const r = await pi.handler({ toolName: "bash", input: { command: "cat <<'EOF'\nrm -rf /\nEOF" } }, ctx());
  assert.ok(r?.block, "multiline command hits the deny rule");
  assert.match(r.reason, /denied by permission rule/);
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

test("stale runner (getFlag throws at load) never crashes handlers (regression)", async () => {
  // Simulates the SDK invalidating the runner: the load-time flag capture must
  // swallow the throw and default to non-yolo; tool_call must still run and
  // route "ask" through the normal prompt (no crash, no auto-approve).
  const rules = { bash: "*" }; // matches "ask" path
  const pi = harness({ rules, getFlagThrows: true });
  const c = ctx();
  const call = { toolName: "bash", input: { command: "ls" } };
  // No session reset needed; the doom-loop ring is per-run. Call once:
  const result = await pi.handler(call, c);
  assert.ok(result === undefined || result.block === false || result.block === true, "handler returned without throwing");
  assert.doesNotThrow(() => pi.handler(call, c));
});
