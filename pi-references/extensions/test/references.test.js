import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
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

test("normalizeReference: ~-prefixed path expands to the real home dir", () => {
  const r = normalizeReference("notes", "~/docs/notes", "/proj", "/cache");
  assert.equal(r.path, join(os.homedir(), "docs/notes"));
  assert.equal(normalizeReference("h", "~", "/proj", "/cache").path, os.homedir());
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

test("ensureCloned: failed clone removes the created cache dir so a retry can re-clone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  try {
    const ref = { alias: "sdk", path: join(dir, "sdk"), repository: "owner/repo" };
    const exec = async () => ({ failed: true, stderr: "network down" });
    assert.equal(await ensureCloned(ref, exec), false);
    assert.equal(existsSync(ref.path), false, "partial cache dir removed for retry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// git sees the dir we mkdir'd as pre-existing, so on mid-fetch failure it
// leaves a partial .git behind — that dir must not be reported as cloned.
test("ensureCloned: partial .git from a failed clone in a created dir is fully removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  try {
    const ref = { alias: "sdk", path: join(dir, "sdk"), repository: "owner/repo" };
    const exec = async (_cmd, _args) => {
      mkdirSync(join(ref.path, ".git"), { recursive: true }); // git's partial init
      writeFileSync(join(ref.path, ".git", "config"), "partial", "utf8");
      return { failed: true, stderr: "fatal: early EOF" };
    };
    assert.equal(await ensureCloned(ref, exec), false);
    assert.equal(existsSync(ref.path), false, "partial clone dir removed entirely");
    // A retry must not take the .git early-return — it would claim success.
    const execOk = async () => ({ failed: false });
    assert.equal(await ensureCloned(ref, execOk), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureCloned: failed clone never touches a non-empty cache dir (no recursive delete)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  const cache = join(dir, "cache");
  mkdirSync(join(cache, "precious"), { recursive: true });
  writeFileSync(join(cache, "precious", "data"), "keep", "utf8");
  try {
    // The "alias .." escape: ref.path points at a non-empty existing dir.
    const ref = { alias: "..", path: cache, repository: "owner/repo" };
    const exec = async () => ({ failed: true });
    assert.equal(await ensureCloned(ref, exec), false);
    assert.equal(readFileSync(join(cache, "precious", "data"), "utf8"), "keep",
      "existing content must survive a failed clone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeReference rejects dot-segment aliases (cache-root escape)", () => {
  assert.equal(normalizeReference("..", { repository: "owner/repo" }, "/p", "/cache"), null);
  assert.equal(normalizeReference(".", { repository: "owner/repo" }, "/p", "/cache"), null);
  assert.notEqual(normalizeReference("docs", { repository: "owner/repo" }, "/p", "/cache"), null);
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

function ctx({ cwd, trusted } = {}) {
  const notifies = [];
  return {
    cwd: cwd || "/proj",
    hasUI: true,
    isProjectTrusted: () => trusted === true,
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
  // before_agent_start with no snippet: no return value (runner keeps prompt)
  const event = { systemPrompt: "BASE" };
  assert.equal(pi.calls.handlers.before_agent_start(event, c), undefined);
});

test("before_agent_start returns systemPrompt = event.systemPrompt + snippet", () => {
  const pi = harness({ setting: { docs: { path: "../d", description: "docs" } } });
  const c = ctx();
  pi.calls.handlers.session_start({}, c);
  const event = { systemPrompt: "BASE" };
  const result = pi.calls.handlers.before_agent_start(event, c);
  assert.match(result.systemPrompt, /^BASE/);
  assert.match(result.systemPrompt, /Project references/);
  assert.match(result.systemPrompt, /@docs/);
  assert.equal(
    result.systemPrompt,
    "BASE\n\n" + result.systemPrompt.slice(result.systemPrompt.indexOf("## Project references")),
  );
});

test("before_agent_start appends snippet to event.systemPrompt, does not mutate event", () => {
  const pi = harness({ setting: { docs: { path: "../d", description: "docs" } } });
  const c = ctx();
  pi.calls.handlers.session_start({}, c);
  const event = { systemPrompt: "BASE\n\nTAIL", systemPromptOptions: { appendSystemPrompt: "OLD" } };
  const result = pi.calls.handlers.before_agent_start(event, c);
  const snippet = result.systemPrompt.slice(result.systemPrompt.indexOf("## Project references"));
  assert.equal(result.systemPrompt, "BASE\n\nTAIL\n\n" + snippet);
  assert.equal(event.systemPromptOptions.appendSystemPrompt, "OLD",
    "options object must stay untouched (read-only inspection state)");
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
  assert.ok(pi.calls.registeredCmds.find((n) => n === "refs"), "/refs registered");
  const result = pi.calls.handlers.before_agent_start({ systemPrompt: "BASE" }, c);
  assert.match(result.systemPrompt, /@docs/);
  // sdk has no description → not advertised, but still configured.
  assert.equal(result.systemPrompt.includes("@sdk"), false);
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

// ── Trust gate: project settings need a trusted project ───────────────────

function projectWithRefs() {
  const dir = mkdtempSync(join(tmpdir(), "refs-proj-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "settings.json"),
    JSON.stringify({ references: { docs: { path: "../d", description: "evil docs" } } }),
  );
  return dir;
}

test("untrusted project: .pi/settings.json refs ignored (no clone, no prompt injection)", () => {
  const dir = projectWithRefs();
  try {
    const pi = harness({ setting: undefined });
    const c = ctx({ cwd: dir, trusted: false });
    pi.calls.handlers.session_start({}, c);
    const result = pi.calls.handlers.before_agent_start({ systemPrompt: "BASE" }, c);
    assert.equal(result, undefined,
      "untrusted project refs must not reach the system prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trusted project: .pi/settings.json refs honored", () => {
  const dir = projectWithRefs();
  try {
    const pi = harness({ setting: undefined });
    const c = ctx({ cwd: dir, trusted: true });
    pi.calls.handlers.session_start({}, c);
    const result = pi.calls.handlers.before_agent_start({ systemPrompt: "BASE" }, c);
    assert.match(result.systemPrompt, /@docs/);
    assert.match(result.systemPrompt, /evil docs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("untrusted project: global settings.json still honored (global read is unconditional)", () => {
  const dir = projectWithRefs();
  const globalDir = mkdtempSync(join(tmpdir(), "refs-global-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(
      join(globalDir, "settings.json"),
      JSON.stringify({ references: { gdocs: { path: "../g", description: "global docs" } } }),
    );
    process.env.PI_CODING_AGENT_DIR = globalDir;
    const pi = harness({ setting: undefined });
    const c = ctx({ cwd: dir, trusted: false });
    pi.calls.handlers.session_start({}, c);
    const result = pi.calls.handlers.before_agent_start({ systemPrompt: "BASE" }, c);
    assert.match(result.systemPrompt, /@gdocs/,
      "global config applies regardless of project trust");
    assert.equal(result.systemPrompt.includes("@docs"), false,
      "untrusted project refs still ignored");
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});
