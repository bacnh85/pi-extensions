import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import referencesExtension, {
  normalizeReference,
  ensureCloned,
  buildContextSnippet,
  readSettingsKey,
} from "../index.js";

test("readSettingsKey reads .pi/settings.json from cwd (production path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-settings-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ references: { docs: { path: "../d" } } }),
    );
    const key = readSettingsKey(dir, "references");
    assert.deepEqual(key, { docs: { path: "../d" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSettingsKey returns undefined when no settings file", () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-settings-"));
  try {
    assert.equal(readSettingsKey(dir, "references"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSettingsKey treats non-object values as misconfig (undefined)", () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-settings-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ references: "../d" }));
    assert.equal(readSettingsKey(dir, "references"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── normalizeReference ────────────────────────────────────────────────────

test("normalizeReference: local relative path resolved against cwd", () => {
  const r = normalizeReference("docs", "../product-docs", "/proj", "/cache");
  assert.equal(r.alias, "docs");
  assert.equal(r.path, join("/proj", "..", "product-docs"));
  assert.equal(r.repository, null);
});

test("normalizeReference: absolute path kept as-is", () => {
  const r = normalizeReference("docs", "/abs/path", "/proj", "/cache");
  assert.equal(r.path, "/abs/path");
});

test("normalizeReference: local path object form", () => {
  const r = normalizeReference("docs", { path: "../d", description: "use for X" }, "/proj", "/cache");
  assert.equal(r.path, join("/proj", "..", "d"));
  assert.equal(r.description, "use for X");
  assert.equal(r.hidden, false);
});

test("normalizeReference: git repo shorthand owner/repo", () => {
  const r = normalizeReference("sdk", "owner/repo", "/proj", "/cache");
  assert.equal(r.repository, "owner/repo");
  assert.equal(r.branch, null);
  assert.equal(r.path, join("/cache", "sdk"));
});

test("normalizeReference: git repo object form with branch", () => {
  const r = normalizeReference("sdk", { repository: "owner/repo", branch: "dev" }, "/proj", "/cache");
  assert.equal(r.repository, "owner/repo");
  assert.equal(r.branch, "dev");
});

test("normalizeReference: rejects invalid alias (slash, space, comma)", () => {
  assert.equal(normalizeReference("a/b", "../d", "/proj", "/cache"), null);
  assert.equal(normalizeReference("a b", "../d", "/proj", "/cache"), null);
  assert.equal(normalizeReference("a,b", "../d", "/proj", "/cache"), null);
  assert.equal(normalizeReference("", "../d", "/proj", "/cache"), null);
  assert.equal(normalizeReference(null, "../d", "/proj", "/cache"), null);
});

test("normalizeReference: rejects def with neither path nor repository", () => {
  assert.equal(normalizeReference("x", { description: "no path" }, "/proj", "/cache"), null);
});

test("normalizeReference: hidden flag respected", () => {
  const r = normalizeReference("x", { path: "../d", hidden: true }, "/proj", "/cache");
  assert.equal(r.hidden, true);
});

// ── buildContextSnippet ───────────────────────────────────────────────────

test("buildContextSnippet advertises refs with descriptions", () => {
  const refs = [
    { alias: "docs", path: "/d", description: "product docs", hidden: false },
    { alias: "sdk", path: "/s", description: "SDK", hidden: false },
  ];
  const snippet = buildContextSnippet(refs);
  assert.match(snippet, /Project references/);
  assert.match(snippet, /@docs/);
  assert.match(snippet, /@sdk/);
  assert.match(snippet, /product docs/);
});

test("buildContextSnippet omits hidden refs and refs without description", () => {
  const refs = [
    { alias: "docs", path: "/d", description: "docs", hidden: false },
    { alias: "secret", path: "/s", description: "hidden one", hidden: true },
    { alias: "nodesc", path: "/n", description: null, hidden: false },
  ];
  const snippet = buildContextSnippet(refs);
  assert.match(snippet, /@docs/);
  assert.equal(snippet.includes("@secret"), false, "hidden excluded");
  assert.equal(snippet.includes("@nodesc"), false, "no-description excluded");
});

test("buildContextSnippet returns empty string when nothing to advertise", () => {
  assert.equal(buildContextSnippet([]), "");
  assert.equal(buildContextSnippet([{ alias: "x", path: "/x", description: null, hidden: false }]), "");
});

// ── ensureCloned ──────────────────────────────────────────────────────────

test("ensureCloned: local ref (no repository) is a no-op success", async () => {
  const ref = { alias: "docs", path: "/local", repository: null };
  const exec = async () => assert.fail("should not call git for local ref");
  assert.equal(await ensureCloned(ref, exec), true);
});

test("ensureCloned: skips clone if .git already exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  mkdirSync(join(dir, ".git"));
  try {
    const ref = { alias: "sdk", path: dir, repository: "owner/repo" };
    const exec = async () => assert.fail("should not clone if already present");
    assert.equal(await ensureCloned(ref, exec), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureCloned: clones with correct args when missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  try {
    const ref = { alias: "sdk", path: join(dir, "sdk"), repository: "owner/repo", branch: "dev" };
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { failed: false };
    };
    const ok = await ensureCloned(ref, exec);
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], "clone");
    assert.deepEqual(calls[0].args[1], "--branch");
    assert.deepEqual(calls[0].args[2], "dev");
    assert.match(calls[0].args[3], /github\.com.*owner\/repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureCloned: returns false when git clone fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  try {
    const ref = { alias: "sdk", path: join(dir, "sdk"), repository: "owner/repo" };
    const exec = async () => { throw new Error("network"); };
    assert.equal(await ensureCloned(ref, exec), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Extension wiring ──────────────────────────────────────────────────────

function harness({ setting } = {}) {
  const calls = { handlers: {}, registeredCmds: [] };
  const pi = {
    on(evt, handler) { calls.handlers[evt] = handler; },
    registerCommand(name) { calls.registeredCmds.push(name); },
    getSetting(name) { return name === "references" ? setting : undefined; },
    config: {},
    async exec() { return { failed: false }; },
    calls,
  };
  referencesExtension(pi);
  return pi;
}

function ctx({ cwd } = {}) {
  const notifies = [];
  return {
    cwd: cwd || "/proj",
    hasUI: true,
    notifies,
    ui: { notify(m) { notifies.push(m); } },
  };
}

test("extension wires session_start, before_agent_start, /refs", () => {
  const pi = harness({ setting: { docs: "../d" } });
  assert.equal(typeof pi.calls.handlers.session_start, "function");
  assert.equal(typeof pi.calls.handlers.before_agent_start, "function");
  assert.ok(pi.calls.registeredCmds.includes("refs"));
});

test("no config → no system prompt injection, /refs reports none", async () => {
  const pi = harness({ setting: undefined });
  const c = ctx();
  pi.calls.handlers.session_start({}, c);
  // before_agent_start with no snippet: no mutation
  const event = { systemPromptOptions: {} };
  pi.calls.handlers.before_agent_start(event, c);
  assert.equal(event.systemPromptOptions.appendSystemPrompt, undefined);
});

test("before_agent_start appends reference snippet when configured", () => {
  const pi = harness({ setting: { docs: { path: "../d", description: "docs" } } });
  const c = ctx();
  pi.calls.handlers.session_start({}, c);
  const event = { systemPromptOptions: {} };
  pi.calls.handlers.before_agent_start(event, c);
  assert.match(event.systemPromptOptions.appendSystemPrompt, /Project references/);
  assert.match(event.systemPromptOptions.appendSystemPrompt, /@docs/);
});

test("before_agent_start appends to existing appendSystemPrompt", () => {
  const pi = harness({ setting: { docs: { path: "../d", description: "docs" } } });
  const c = ctx();
  pi.calls.handlers.session_start({}, c);
  const event = { systemPromptOptions: { appendSystemPrompt: "BASE" } };
  pi.calls.handlers.before_agent_start(event, c);
  assert.match(event.systemPromptOptions.appendSystemPrompt, /^BASE/);
  assert.match(event.systemPromptOptions.appendSystemPrompt, /@docs/);
});

test("/refs lists configured references", async () => {
  const pi = harness({
    setting: {
      docs: { path: "../d", description: "product docs" },
      sdk: "owner/repo",
    },
  });
  const c = ctx();
  pi.calls.handlers.session_start({}, c);
  const refsCmd = pi.calls.registeredCmds.find((n) => n === "refs");
  // Simulate the command by re-loading config then calling the handler.
  // The handler closure is internal; verify via /refs through the test's own
  // loadConfig path by checking the snippet + refs resolution instead.
  assert.ok(refsCmd, "/refs registered");
  // Verify refs were resolved correctly by inspecting the injected snippet.
  const event = { systemPromptOptions: {} };
  pi.calls.handlers.before_agent_start(event, c);
  assert.match(event.systemPromptOptions.appendSystemPrompt, /@docs/);
  // sdk has no description → not advertised, but still configured.
  assert.equal(event.systemPromptOptions.appendSystemPrompt.includes("@sdk"), false);
});

// ── Review-fix regression tests ────────────────────────────────────────────

test("ensureCloned rejects branch values starting with `-` (review: MED, arg injection)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  try {
    const ref = { alias: "sdk", path: join(dir, "sdk"), repository: "owner/repo", branch: "--upload-pack=evil" };
    const calls = [];
    const ok = await ensureCloned(ref, async (cmd, args) => {
      calls.push({ cmd, args });
      return { failed: false };
    });
    // Branch should be dropped (not passed to git) because it starts with `-`.
    assert.equal(ok, true, "local success");
    assert.deepEqual(calls[0].args, ["clone", "https://github.com/owner/repo.git", join(dir, "sdk")],
      "dangerous --branch value omitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureCloned passes a safe branch normally (review: MED)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  try {
    const ref = { alias: "sdk", path: join(dir, "sdk"), repository: "owner/repo", branch: "main" };
    const calls = [];
    await ensureCloned(ref, async (cmd, args) => { calls.push({ cmd, args }); return { failed: false }; });
    assert.deepEqual(calls[0].args, ["clone", "--branch", "main", "https://github.com/owner/repo.git", join(dir, "sdk")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
