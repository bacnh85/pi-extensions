import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSettingsPackages, resolveSource, searchCatalog, mergeResults } from "../../cli.js";

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
