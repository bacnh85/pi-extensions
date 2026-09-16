import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import {
  countBackups,
  isValidRelpath,
  latestDeletedSnapshot,
  listBackups,
  listDeletedSnapshots,
  namedBackup,
  snapshot,
  snapshotDir,
} from "../lib/backup";

describe("backup", () => {
  let agent: string;

  beforeEach(() => {
    agent = mkdtempSync(join(tmpdir(), "pi-selfskills-bak-"));
    process.env.PI_CODING_AGENT_DIR = agent;
  });
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(agent, { recursive: true, force: true });
  });

  it("snapshot (SKILL.md default) uses nested v2 layout with ms-stamped content-hash name", () => {
    const { file } = snapshot("my-skill", "v1 content", 10);
    expect(file).to.match(/\d{8}-\d{6}\.\d{3}-[0-9a-f]{10}\.md$/);
    expect(file).to.include(join("selfskills", "backups", "my-skill", "SKILL.md"));
    expect(readFileSync(file, "utf8")).to.equal("v1 content");
  });

  it("snapshot with relpath lands under backups/<skill>/<relpath>/, capped per relpath", () => {
    snapshot("s", "ref v1", 10, agent, "references/api.md");
    snapshot("s", "ref v2", 10, agent, "references/api.md");
    const refs = listBackups("s", "references/api.md");
    expect(refs.length).to.equal(2);
    expect(readFileSync(refs[1], "utf8")).to.equal("ref v2");
    // SKILL.md history is untouched by references/ snapshots
    expect(listBackups("s").length).to.equal(0);
    // cap=1 per relpath
    snapshot("s", "ref v3", 1, agent, "references/api.md");
    const after = listBackups("s", "references/api.md");
    expect(after.length).to.equal(1);
    expect(readFileSync(after[0], "utf8")).to.equal("ref v3");
  });

  it("legacy flat SKILL.md backups merge into SKILL.md lookups", () => {
    const legacyDir = join(agent, "selfskills", "backups", "s");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "20260101-000000-abcdefabcd.md"), "legacy", "utf8");
    snapshot("s", "nested", 10); // v2 nested snapshot
    const all = listBackups("s");
    expect(all.length).to.equal(2);
    expect(readFileSync(all[0], "utf8")).to.equal("legacy"); // older mtime → first
    // named lookup finds the legacy flat file too
    const named = namedBackup("s", "20260101-000000-abcdefabcd");
    expect(named).to.exist;
    expect(readFileSync(named!, "utf8")).to.equal("legacy");
  });

  it("ordering: oldest first; newest survives cap=1 (mtimes backdated for determinism)", () => {
    const { file: f1 } = snapshot("s", "older", 10);
    snapshot("s", "newer", 10);
    utimesSync(f1, 1000, 1000);
    const all = listBackups("s");
    expect(readFileSync(all[0], "utf8")).to.equal("older");
    expect(readFileSync(all[1], "utf8")).to.equal("newer");
    // cap=1 keeps the newest even if mtimes tie
    snapshot("t", "t1", 1);
    utimesSync(listBackups("t")[0], 1000, 1000);
    snapshot("t", "t2", 1);
    const t = listBackups("t");
    expect(t.length).to.equal(1);
    expect(readFileSync(t[0], "utf8")).to.equal("t2");
  });

  it("namedBackup refuses non-generated names (traversal / arbitrary paths)", () => {
    snapshot("s", "content", 10);
    expect(namedBackup("s", "../../evil.md")).to.equal(null);
    expect(namedBackup("s", "sub/dir")).to.equal(null);
    expect(namedBackup("s", "random-notes.md")).to.equal(null);
    expect(namedBackup("s", "..")).to.equal(null);
  });

  it("unknown skill → no backups", () => {
    expect(listBackups("nope")).to.deep.equal([]);
    expect(namedBackup("nope", "whatever")).to.equal(null);
    expect(countBackups()).to.equal(0);
  });

  it("countBackups sums across skills, relpaths and deletion snapshots", () => {
    snapshot("a", "x", 10);
    snapshot("a", "y", 10, agent, "references/r.md");
    snapshot("b", "z", 10);
    snapshotDir("a", [{ relpath: "SKILL.md", content: "m" }], 10);
    expect(countBackups()).to.equal(4);
  });

  it("snapshotDir snapshots a full file set; cap prunes oldest snapshot dirs", () => {
    snapshotDir("s", [{ relpath: "SKILL.md", content: "m1" }, { relpath: "references/a.md", content: "a1" }], 10);
    snapshotDir("s", [{ relpath: "SKILL.md", content: "m2" }], 10);
    snapshotDir("s", [{ relpath: "SKILL.md", content: "m3" }], 10);
    const snaps = listDeletedSnapshots("s");
    expect(snaps.length).to.equal(3);
    expect(readFileSync(join(snaps[0].dir, "SKILL.md"), "utf8")).to.equal("m1");
    expect(existsSync(join(snaps[0].dir, "references", "a.md"))).to.equal(true);
    const latest = latestDeletedSnapshot("s")!;
    expect(readFileSync(join(latest.dir, "SKILL.md"), "utf8")).to.equal("m3");
    // cap prunes whole snapshot dirs
    snapshotDir("s", [{ relpath: "SKILL.md", content: "m4" }], 3);
    const after = listDeletedSnapshots("s");
    expect(after.length).to.equal(3);
    expect(readFileSync(join(latestDeletedSnapshot("s")!.dir, "SKILL.md"), "utf8")).to.equal("m4");
    expect(existsSync(join(listDeletedSnapshots("s")[0].dir, "references", "a.md"))).to.equal(false);
  });

  it("isValidRelpath rejects traversal, absolute, empty and dot segments", () => {
    expect(isValidRelpath("SKILL.md")).to.equal(true);
    expect(isValidRelpath("references/api.md")).to.equal(true);
    expect(isValidRelpath("")).to.equal(false);
    expect(isValidRelpath("../x")).to.equal(false);
    expect(isValidRelpath("a/../b")).to.equal(false);
    expect(isValidRelpath("/abs")).to.equal(false);
    expect(isValidRelpath("a//b")).to.equal(false);
  });
});
