/**
 * Regression guard for skill frontmatter (0.16.1 incident): pi refuses to
 * load a skill whose description exceeds 1024 characters, so an oversized
 * description is a load error on every session — not a cosmetic issue.
 * Every skills/<name>/SKILL.md must parse and stay within the limit.
 */

import { expect } from "chai";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");

/** Minimal frontmatter parser — single-line values plus `>` / `|` folded blocks. */
function frontmatter(source: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(source);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w][\w-]*):\s?(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, inline] = kv;
    if (/^[>|][+-]?$/.test(inline.trim())) {
      const body: string[] = [];
      for (i += 1; i < lines.length && (/^\s/.test(lines[i]) || lines[i] === ""); i++) {
        if (lines[i].trim()) body.push(lines[i].trim());
      }
      out[key] = body.join(" ");
      i -= 1;
    } else {
      out[key] = inline.trim();
    }
  }
  return out;
}

describe("pi-web skill frontmatter", () => {
  const skillFiles = readdirSync(SKILLS_DIR)
    .filter((d) => !d.startsWith("."))
    .map((d) => path.join(SKILLS_DIR, d, "SKILL.md"))
    .filter((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    });

  it("discovers at least one skill", () => {
    expect(skillFiles.length).to.be.at.least(1);
  });

  for (const file of skillFiles) {
    const skillName = path.basename(path.dirname(file));

    it(`${skillName}: has a name and description`, () => {
      const fm = frontmatter(readFileSync(file, "utf8"));
      expect(fm.name).to.match(/^[a-z0-9-]+$/);
      expect(fm.description).to.be.a("string").with.length.at.least(20);
    });

    it(`${skillName}: description fits pi's 1024-char load limit`, () => {
      // pi folds folded blocks to single-line whitespace before measuring.
      const fm = frontmatter(readFileSync(file, "utf8"));
      const folded = fm.description.split(/\s+/).join(" ").trim();
      // The 0.16.0 incident: 1107 chars => [Skill conflicts] on every session.
      expect(folded.length, `${skillName} description is ${folded.length} chars`).to.be.at.most(1024);
    });
  }
});
