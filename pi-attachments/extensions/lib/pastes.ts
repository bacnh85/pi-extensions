/**
 * Collapsed large text pastes (Hermes-style): the pasted payload is written to
 * <agentDir>/pastes/paste_<n>_<HHMMSS>_<pid>.txt and the editor receives an
 * [[attach:name]] token. Unlike Hermes — which re-inlines the full content at
 * submit — the token resolves to a 📎 path, so the paste stays isolated from
 * the chat text and the model reads it on demand.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ponytail: oldest-evicted cap; Hermes keeps paste files forever, we don't
const KEEP = 50;

/** Matches paste filenames across modules (inline-suppression, sweep). */
export const PASTE_NAME_RE = /^paste_\d+_\d{6}_\d+\.txt$/;

export function pastesDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(dir, "pastes");
}

let counter = 0;

/** Write a paste file, sweep old ones beyond `keep`, return its absolute path. */
export function savePaste(content: string, keep = KEEP): string {
  const dir = pastesDir();
  mkdirSync(dir, { recursive: true });
  const time = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
  // pid suffix: counter is per-process and the timestamp has 1s resolution —
  // two pi sessions sharing the agent dir could otherwise collide and overwrite.
  const path = join(dir, `paste_${++counter}_${time}_${process.pid}.txt`);
  writeFileSync(path, content, { mode: 0o600 });
  try {
    const files = readdirSync(dir)
      .filter((f) => PASTE_NAME_RE.test(f))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    for (const { f } of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, f));
  } catch {
    /* best-effort sweep */
  }
  return path;
}
