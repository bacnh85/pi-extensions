// SKILL.md building, targeted patching, SDK validation, atomic writes.
import { createHash } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/** sha256 hex prefix — backup names + read-time hash precondition. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SKILL_NAME_RE.test(name);
}

/**
 * Frontmatter + body. Description is emitted as a JSON string — valid YAML
 * double-quoted scalar — so colons/#/quotes in the description can't break
 * frontmatter parsing.
 */
export function buildSkillContent(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

export type PatchResult =
  | { ok: true; content: string }
  | { ok: false; reason: string; occurrences: number };

/** Targeted replacement. Caller enforces old !== new and non-empty old. */
export function applyPatch(content: string, oldString: string, newString: string): PatchResult {
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return { ok: false, reason: "old_string not found in skill content", occurrences: 0 };
  if (occurrences > 1) {
    return { ok: false, reason: `old_string matches ${occurrences} locations; it must be unique`, occurrences };
  }
  return { ok: true, content: content.replace(oldString, newString) };
}

export interface ValidateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate skill content through the real SDK loader in a throwaway temp dir.
 * Passes iff exactly one skill loads (broken frontmatter → skill silently
 * doesn't load), its name matches when given, and no error diagnostics fire.
 * Note: the SDK emits only warning/collision diagnostics — a parse failure
 * surfaces as an empty skills array, which the length check catches.
 */
export function validateSkillContent(content: string, expectedName?: string): ValidateResult {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-selfskills-validate-"));
  try {
    writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "validate" });
    if (skills.length !== 1) {
      const why = diagnostics
        .filter((d) => d.type !== "collision")
        .map((d) => d.message)
        .join("; ");
      return { ok: false, reason: `SDK validation failed: skill did not load${why ? ` (${why})` : ""}` };
    }
    if (expectedName && skills[0].name !== expectedName) {
      return {
        ok: false,
        reason: `SDK validation failed: frontmatter name is "${skills[0].name}", expected "${expectedName}"`,
      };
    }
    const errs = diagnostics.filter((d) => d.type === "error");
    if (errs.length > 0) {
      return { ok: false, reason: `SDK validation errors: ${errs.map((e) => e.message).join("; ")}` };
    }
    return { ok: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write via sibling temp file + rename so concurrent readers never see a partial file.
 *  Accepts strings or Buffers (byte-for-byte restores of binary assets). */
export function atomicWrite(filePath: string, content: string | Buffer): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}
