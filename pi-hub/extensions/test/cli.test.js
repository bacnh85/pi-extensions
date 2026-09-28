import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSettingsPackages, resolveSource, searchCatalog, mergeResults, main } from "../../cli.js";

test("resolveSource: passthrough for explicit sources", () => {
  assert.equal(resolveSource("npm:@foo/bar"), "npm:@foo/bar");
  assert.equal(resolveSource("git:github.com/user/repo"), "git:github.com/user/repo");
  assert.equal(resolveSource("https://github.com/user/repo"), "https://github.com/user/repo");
});

test("resolveSource: scoped npm shorthand", () => {
  assert.equal(resolveSource("@scope/pkg"), "npm:@scope/pkg");
});

test("resolveSource: owner/repo shorthand becomes git", () => {
  assert.equal(resolveSource("user/repo"), "git:github.com/user/repo");
});

test("resolveSource: catalog dir name resolves to scoped npm", () => {
  assert.equal(resolveSource("pi-plan"), "npm:@bacnh85/pi-plan");
});

test("resolveSource: bare name falls through to npm", () => {
  assert.equal(resolveSource("left-pad"), "npm:left-pad");
});

test("searchCatalog matches dir, name, and description", () => {
  const hits = searchCatalog("plan");
  assert.ok(hits.some((c) => c.dir === "pi-plan"));
  const none = searchCatalog("zzzqqqxxx");
  assert.equal(none.length, 0);
});

test("mergeResults: curated first, npm deduped by name", () => {
  const curated = [{ name: "@bacnh85/pi-plan", dir: "pi-plan", description: "d" }];
  const npm = [
    { name: "@bacnh85/pi-plan", description: "d" },
    { name: "some-other-pi-package", description: "e" },
  ];
  const merged = mergeResults(curated, npm);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].curated, true);
  assert.equal(merged[1].name, "some-other-pi-package");
  assert.ok(!("curated" in merged[1])); // npm entries never marked curated
});

test("readSettingsPackages: HOME/USERPROFILE-relative settings.json, string + {source} forms", () => {
  const home = mkdtempSync(path.join(tmpdir(), "pi-hub-test-"));
  try {
    assert.deepEqual(readSettingsPackages({ HOME: home }), []); // missing file → []
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: ["npm:@x/a", { source: "npm:@x/b" }, { nope: true }] }),
    );
    assert.deepEqual(readSettingsPackages({ HOME: home }), ["npm:@x/a", "npm:@x/b"]);
    assert.deepEqual(readSettingsPackages({ USERPROFILE: home }), ["npm:@x/a", "npm:@x/b"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readSettingsPackages: PI_CODING_AGENT_DIR wins over HOME/USERPROFILE", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-test-"));
  try {
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["npm:@x/c"] }));
    assert.deepEqual(readSettingsPackages({ PI_CODING_AGENT_DIR: dir, HOME: "/nonexistent" }), ["npm:@x/c"]);
    // empty string counts as unset → falls back to HOME layout
    mkdirSync(path.join(dir, ".pi", "agent"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@x/d"] }));
    assert.deepEqual(readSettingsPackages({ PI_CODING_AGENT_DIR: "", HOME: dir }), ["npm:@x/d"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add: failed pi install resolves 1 and prints the failure", { skip: process.platform === "win32" }, async () => {
  // PATH shim: fake `pi` that always exits 1
  const shim = mkdtempSync(path.join(tmpdir(), "pi-hub-shim-"));
  writeFileSync(path.join(shim, "pi"), "#!/bin/sh\nexit 1\n");
  chmodSync(path.join(shim, "pi"), 0o755);
  const realPath = process.env.PATH;
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  let code;
  try {
    process.env.PATH = `${shim}${path.delimiter}${realPath}`;
    code = await main(["add", "definitely-not-real"]);
  } finally {
    process.env.PATH = realPath;
    console.log = orig;
    rmSync(shim, { recursive: true, force: true });
  }
  assert.equal(code, 1, "exit code 1 when pi install fails");
  assert.ok(logs.some((l) => /install failed: definitely-not-real/.test(l)), "failure message printed");
});

test("add: signal-killed pi resolves 1 (status null is failure, not success)", { skip: process.platform === "win32" }, async () => {
  const shim = mkdtempSync(path.join(tmpdir(), "pi-hub-shim-"));
  writeFileSync(path.join(shim, "pi"), "#!/bin/sh\nkill -9 $$\n");
  chmodSync(path.join(shim, "pi"), 0o755);
  const realPath = process.env.PATH;
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  let code;
  try {
    process.env.PATH = `${shim}${path.delimiter}${realPath}`;
    code = await main(["add", "signal-victim"]);
  } finally {
    process.env.PATH = realPath;
    console.log = orig;
    rmSync(shim, { recursive: true, force: true });
  }
  assert.equal(code, 1, "exit code 1 when pi dies from a signal");
  assert.ok(logs.some((l) => /install failed: signal-victim/.test(l)), "failure message printed");
});

test("add: multi-ref install prints the failure summary with the count", { skip: process.platform === "win32" }, async () => {
  // Shim: --version exits 0 (piInstalled), install exits 1 (always fails).
  const shim = mkdtempSync(path.join(tmpdir(), "pi-hub-shim-"));
  writeFileSync(path.join(shim, "pi"), '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 1\n');
  chmodSync(path.join(shim, "pi"), 0o755);
  const realPath = process.env.PATH;
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  let code;
  try {
    process.env.PATH = `${shim}${path.delimiter}${realPath}`;
    code = await main(["add", "bad-one", "bad-two"]);
  } finally {
    process.env.PATH = realPath;
    console.log = orig;
    rmSync(shim, { recursive: true, force: true });
  }
  assert.equal(code, 1);
  assert.ok(logs.some((l) => /2 install\(s\) failed/.test(l)), "summary line printed for -y users too");
});

test("add: missing pi binary (ENOENT) gets the friendly install hint, exit 1", { skip: process.platform === "win32" }, async () => {
  const realPath = process.env.PATH;
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  let code;
  try {
    process.env.PATH = ""; // no `pi` anywhere → spawnSync ENOENT
    code = await main(["add", "pi-plan"]);
  } finally {
    process.env.PATH = realPath;
    console.log = orig;
  }
  assert.equal(code, 1);
  assert.ok(logs.some((l) => l.includes("not found on PATH")), "friendly message printed");
  assert.ok(!logs.some((l) => /ENOENT/.test(l)), "no cryptic spawnSync error leaked");
});


test("resolveSource: shell metacharacters throw (all branches)", () => {
  assert.throws(() => resolveSource("pkg&whoami"), /invalid source/);
  assert.throws(() => resolveSource("pkg;rm"), /invalid source/);
  assert.throws(() => resolveSource("$(whoami)"), /invalid source/);
  // explicit-prefix passthrough is guarded too — the prefix doesn't launder the ref
  assert.throws(() => resolveSource("npm:foo&calc"), /invalid source/);
  assert.throws(() => resolveSource("git:github.com/x;y/repo"), /invalid source/);
  // safe forms still pass through
  assert.equal(resolveSource("pi-plan"), "npm:@bacnh85/pi-plan");
  assert.equal(resolveSource("npm:@scope/pkg"), "npm:@scope/pkg");
  assert.equal(resolveSource("git:github.com/user/repo"), "git:github.com/user/repo");
  assert.equal(resolveSource("left-pad"), "npm:left-pad");
});

test("remove rejects -l/--local — only valid with add", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (msg) => logs.push(msg);
  let code;
  try {
    code = await main(["remove", "-l", "pi-plan"]);
  } finally {
    console.log = orig;
  }
  assert.equal(code, 1, "exit code 1 on flag misuse");
  assert.equal(logs.length, 1, "error only — no `pi remove` ran");
  assert.match(logs[0], /-l\/--local is only valid with add — remove takes package names/);
});

test("resolveSource: pi-classifier resolves to scoped npm (catalog drift regression)", () => {
  assert.equal(resolveSource("pi-classifier"), "npm:@bacnh85/pi-classifier");
});

test("catalog completeness: every monorepo pi-package has a catalog entry", () => {
  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  const catalog = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "..", "catalog.json"), "utf8"));
  const dirs = new Set(catalog.map((c) => c.dir));
  // pi-hub is the installer itself; pi-config-panel is a library, not installable (0.1.4 policy).
  const skipped = new Set(["pi-hub", "pi-config-panel", "node_modules"]);
  const missing = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || skipped.has(ent.name) || !ent.name.startsWith("pi-")) continue;
    let pj;
    try {
      pj = JSON.parse(readFileSync(path.join(root, ent.name, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (pj.pi) missing.push(ent.name);
  }
  for (const dir of missing) assert.ok(dirs.has(dir), `${dir} has a "pi" key but no pi-hub catalog entry — add it to catalog.json`);
});
