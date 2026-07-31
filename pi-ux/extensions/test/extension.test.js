import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import uxExtension, {
  parseUxCommand,
  resolveSessionMode,
  readDefaultMode,
  readQuietStartup,
  writeDefaultMode,
} from "../index.js";

function createPiHarness() {
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const appendedEntries = [];

  const pi = {
    on(eventName, handler) {
      events.set(eventName, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    sendUserMessage() {},
  };

  uxExtension(pi);
  return { events, commands, tools, appendedEntries };
}

function createCommandContext(overrides = {}) {
  return {
    isIdle: () => true,
    sessionManager: { getEntries: () => [] },
    ui: { notify() {} },
    ...overrides,
  };
}

function withTempConfig(fn) {
  const tempConfigHome = mkdtempSync(join(tmpdir(), "pi-ux-test-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousHide = process.env.PI_UX_HIDE_STATUS;
  process.env.XDG_CONFIG_HOME = tempConfigHome;
  delete process.env.PI_UX_HIDE_STATUS;

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      if (previousHide === undefined) delete process.env.PI_UX_HIDE_STATUS;
      else process.env.PI_UX_HIDE_STATUS = previousHide;
      rmSync(tempConfigHome, { recursive: true, force: true });
    });
}

test("extension registers the /ux command and ux_audit tool", () => {
  const { commands, tools } = createPiHarness();
  assert.deepEqual([...commands.keys()], ["ux"]);
  assert.deepEqual([...tools.keys()], ["ux_audit"]);
});

test("ux_audit parameter schema has the expected shape", () => {
  const { tools } = createPiHarness();
  const params = tools.get("ux_audit").parameters;
  assert.equal(params.type, "object");
  assert.ok(params.properties.css, "missing css property");
  assert.equal(params.properties.css.type, "string");
  assert.ok(params.properties.pairs, "missing pairs property");
  assert.equal(params.properties.pairs.type, "array");
  assert.ok(params.properties.pairs.items?.properties?.fg, "missing pairs.items.properties.fg");
  assert.ok(params.properties.pairs.items?.properties?.bg, "missing pairs.items.properties.bg");
});

test("ux_audit tool reports a clean pass on token-compliant CSS", async () => withTempConfig(async () => {
  const { tools } = createPiHarness();
  const css = `
    :root { --accent: #0066ff; --text: #111; --bg: #fff; --elev: 0 2px 8px rgba(0,0,0,0.08); }
    .card { color: var(--text); background: var(--bg); box-shadow: var(--elev); padding: 8px; }
    button { color: var(--accent); }
    button:focus-visible { outline: 2px solid var(--accent); }
    button:disabled { opacity: 0.5; }
  `;
  const out = await tools.get("ux_audit").execute(
    "id",
    { css, pairs: [{ fg: "#111", bg: "#fff", label: "body", min: 4.5 }] },
    undefined, undefined, { cwd: "." },
  );
  assert.match(out.content[0].text, /UX AUDIT PASSED/);
  assert.equal(out.details.pass, true);
}));

test("ux_audit tool reports a fail on hardcoded hex + missing states", async () => withTempConfig(async () => {
  const { tools } = createPiHarness();
  const css = `:root { --accent: #0066ff; } .card { color: #ff0000; } button { font-weight: bold; }`;
  const out = await tools.get("ux_audit").execute("id", { css, pairs: [] }, undefined, undefined, { cwd: "." });
  assert.match(out.content[0].text, /UX AUDIT FAILED/);
  assert.equal(out.details.pass, false);
  assert.match(out.content[0].text, /hardcoded hex/);
  assert.match(out.content[0].text, /focus-visible/i);
}));

test("ux_audit tool renders 'n/a' for an invalid colour pair", async () => withTempConfig(async () => {
  const { tools } = createPiHarness();
  const out = await tools.get("ux_audit").execute(
    "id",
    { css: "", pairs: [{ fg: "not-a-color", bg: "#fff", label: "bad", min: 4.5 }] },
    undefined, undefined, { cwd: "." },
  );
  assert.match(out.content[0].text, /UX AUDIT FAILED/);
  assert.match(out.content[0].text, /bad: n\/a/);
}));

test("/ux updates session mode and injects instructions", async () => withTempConfig(async () => {
  const { commands, events, appendedEntries } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ux").handler("lite", ctx);

  assert.deepEqual(appendedEntries.at(-1), {
    customType: "ux-mode",
    data: { mode: "lite" },
  });

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.ok(result.systemPrompt.includes("UX DISCIPLINE ACTIVE"));
  assert.ok(result.systemPrompt.includes("lite"));
}));

test("before_agent_start guards missing event and missing systemPrompt", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);

  for (const bad of [undefined, null]) {
    const r = await events.get("before_agent_start")(bad, ctx);
    assert.ok(r.systemPrompt.includes("UX DISCIPLINE ACTIVE"));
    assert.ok(!r.systemPrompt.includes("undefined"), "must not contain the literal 'undefined'");
  }

  const empty = await events.get("before_agent_start")({}, ctx);
  assert.ok(empty.systemPrompt.includes("UX DISCIPLINE ACTIVE"));
  assert.ok(!empty.systemPrompt.startsWith("undefined"), "must not start with 'undefined'");

  const withBase = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.ok(withBase.systemPrompt.startsWith("BASE\n\n"));
  assert.ok(withBase.systemPrompt.includes("UX DISCIPLINE ACTIVE"));
}));

test("strict banner enforces the audit gate; lite banner recommends it", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);

  await commands.get("ux").handler("strict", ctx);
  const strict = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.match(strict.systemPrompt, /level: strict/);
  assert.match(strict.systemPrompt, /block handoff on fail/i);

  await commands.get("ux").handler("lite", ctx);
  const lite = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.match(lite.systemPrompt, /level: lite/);
  assert.match(lite.systemPrompt, /recommended but not blocking/i);
}));

test("session_start restores latest persisted mode", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const ctx = createCommandContext({
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: "ux-mode", data: { mode: "lite" } },
      ],
    },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.ok(result.systemPrompt.includes("lite"));
}));

test("off mode injects nothing", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ux").handler("off", ctx);
  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.equal(result, undefined);
}));

test("normal mode disables persistent instructions", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ux").handler("strict", ctx);
  await events.get("input")({ text: "normal mode", source: "interactive" }, ctx);

  const disabled = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.equal(disabled, undefined);
}));

test("a request mentioning normal mode stays active", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ux").handler("strict", ctx);
  await events.get("input")({ text: "add a normal mode toggle next to dark mode", source: "interactive" }, ctx);

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.match(result.systemPrompt, /UX DISCIPLINE ACTIVE/);
}));

test("status bar renders the mode and flips on agent_start", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ux-mode", data: { mode: "strict" } }] },
    ui: { notify() {}, setStatus: (key, text) => statusWrites.push({ key, text }), theme: { fg: (_color, text) => text } },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  await events.get("agent_start")({}, ctx);

  assert.equal(statusWrites.at(-1).key, "ux");
  assert.match(statusWrites.at(-1).text, /STRICT/);
}));

test("PI_UX_HIDE_STATUS hides the indicator but keeps ux active", async () => withTempConfig(async () => {
  process.env.PI_UX_HIDE_STATUS = "1";
  const { events } = createPiHarness();
  const statusWrites = [];
  const ctx = createCommandContext({
    sessionManager: { getEntries: () => [{ type: "custom", customType: "ux-mode", data: { mode: "strict" } }] },
    ui: { notify() {}, setStatus: (key, text) => statusWrites.push({ key, text }), theme: { fg: (_c, t) => t } },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  await events.get("agent_start")({}, ctx);
  const injected = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);

  assert.deepEqual(statusWrites, [], "status bar must not be drawn when hidden");
  assert.match(injected.systemPrompt, /UX DISCIPLINE ACTIVE/, "ruleset must still inject while status is hidden");
}));

// --- helpers ---

test("parseUxCommand falls back to strict when invoked bare and default is off", () => {
  assert.deepEqual(parseUxCommand("", "off"), { type: "set-mode", mode: "strict" });
});

test("parseUxCommand parses modes, status, and default subcommand", () => {
  assert.deepEqual(parseUxCommand("lite", "strict"), { type: "set-mode", mode: "lite" });
  assert.deepEqual(parseUxCommand("status", "strict"), { type: "status" });
  assert.deepEqual(parseUxCommand("default lite", "strict"), { type: "set-default", mode: "lite" });
});

test("parseUxCommand accepts off as a valid default (legitimate to disable on startup)", () => {
  assert.deepEqual(parseUxCommand("default off", "strict"), { type: "set-default", mode: "off" });
});

test("resolveSessionMode prefers latest persisted session mode", () => {
  const entries = [
    { type: "custom", customType: "ux-mode", data: { mode: "lite" } },
    { type: "custom", customType: "ux-mode", data: { mode: "strict" } },
  ];
  assert.equal(resolveSessionMode(entries, "strict"), "strict");
});

test("resolveSessionMode returns fallback when entries is not an array", () => {
  assert.equal(resolveSessionMode(null, "strict"), "strict");
  assert.equal(resolveSessionMode("not an array"), "strict"); // DEFAULT_MODE fallback
});

test("readDefaultMode and writeDefaultMode use XDG config path", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-ux-config-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousDefault = process.env.PI_UX_DEFAULT_MODE;
  const configPath = join(tempDir, "pi-ux", "config.json");
  process.env.XDG_CONFIG_HOME = tempDir;
  delete process.env.PI_UX_DEFAULT_MODE;

  try {
    assert.equal(readDefaultMode(), "strict");
    assert.equal(writeDefaultMode("lite"), "lite");
    assert.equal(readDefaultMode(), "lite");
    assert.ok(existsSync(configPath));
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { defaultMode: "lite" });
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousDefault === undefined) delete process.env.PI_UX_DEFAULT_MODE;
    else process.env.PI_UX_DEFAULT_MODE = previousDefault;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("readQuietStartup resolves env var, config file, and default in that order", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-ux-quiet-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousEnv = process.env.PI_UX_QUIET_STARTUP;
  const configDir = join(tempDir, "pi-ux");
  const configPath = join(configDir, "config.json");
  process.env.XDG_CONFIG_HOME = tempDir;
  delete process.env.PI_UX_QUIET_STARTUP;

  try {
    assert.equal(readQuietStartup(), false);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ quietStartup: true }), "utf8");
    assert.equal(readQuietStartup(), true);
    process.env.PI_UX_QUIET_STARTUP = "0";
    assert.equal(readQuietStartup(), false);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousEnv === undefined) delete process.env.PI_UX_QUIET_STARTUP;
    else process.env.PI_UX_QUIET_STARTUP = previousEnv;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
