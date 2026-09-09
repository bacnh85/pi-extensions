import { expect } from "chai";
import {
  applyPatch,
  atomicWrite,
  buildSkillContent,
  isValidSkillName,
  validateSkillContent,
} from "../lib/skillfile";

const VALID = buildSkillContent("test-skill", "Use when testing. Runs the test loop.", "Step one.\nStep two.");

describe("skillfile", () => {
  it("buildSkillContent round-trips through real SDK validation", () => {
    expect(validateSkillContent(VALID, "test-skill").ok).to.equal(true);
    // description containing YAML-hostile chars survives via JSON quoting
    const tricky = buildSkillContent("tricky", "Use when x: y #z \"quoted\"", "b");
    expect(validateSkillContent(tricky, "tricky").ok).to.equal(true);
  });

  it("applyPatch happy path", () => {
    const r = applyPatch(VALID, "Step two.", "Step two, revised.");
    expect(r.ok).to.equal(true);
    if (r.ok) expect(r.content).to.include("Step two, revised.");
  });

  it("applyPatch refuses 0-match and 2-match", () => {
    const zero = applyPatch(VALID, "absent text", "x");
    expect(zero).to.deep.equal({ ok: false, reason: "old_string not found in skill content", occurrences: 0 });
    const twice = VALID.replace("Step one.", "dup\n dup");
    const r = applyPatch(twice, "dup", "y");
    expect(r.ok).to.equal(false);
    if (!r.ok) expect(r.occurrences).to.equal(2);
  });

  it("empty new_string deletes", () => {
    const r = applyPatch(VALID, "Step one.\n", "");
    expect(r.ok).to.equal(true);
    if (r.ok) expect(r.content).to.not.include("Step one.");
  });

  it("validation fails when the description line is removed", () => {
    const broken = VALID.replace('description: "Use when testing. Runs the test loop."\n', "");
    const r = validateSkillContent(broken, "test-skill");
    expect(r.ok).to.equal(false);
    expect(r.reason).to.include("did not load");
  });

  it("name regex accept/reject", () => {
    expect(isValidSkillName("a")).to.equal(true);
    expect(isValidSkillName("my-skill-2")).to.equal(true);
    expect(isValidSkillName("")).to.equal(false);
    expect(isValidSkillName("My-Skill")).to.equal(false);
    expect(isValidSkillName("-lead")).to.equal(false);
    expect(isValidSkillName("trail-")).to.equal(false);
    expect(isValidSkillName("dou--ble")).to.equal(false);
    expect(isValidSkillName("under_score")).to.equal(false);
    expect(isValidSkillName("a".repeat(65))).to.equal(false);
    expect(isValidSkillName("a".repeat(64))).to.equal(true);
  });

  it("atomicWrite lands content via temp+rename", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pi-selfskills-aw-"));
    try {
      const file = join(dir, "f.md");
      atomicWrite(file, "hello");
      expect(readFileSync(file, "utf8")).to.equal("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
