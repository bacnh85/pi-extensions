/**
 * File-path extraction from submitted input text.
 *
 * Conservative by design: images match any existing path with an image
 * extension; text files must be absolute paths (drag-drop and clipboard
 * always produce absolute paths — prose mentions like "see main.rs" never
 * match).
 */

import { statSync } from "node:fs";
// Token may contain backslash-escaped spaces ("with\ space.png" — the form
// terminals paste on file drops); the escaped form is unescaped before fs access.
const IMAGE_RE = /[^\s"']+(?:\\ [^\s"']+)*\.(?:png|jpe?g|webp|gif)\b/gi;
/** Absolute-path token regex: slash segments whose chars may include backslash-escaped spaces (terminal drop form). */
export const ABSOLUTE_PATH_RE = /(?:\/(?:[\w.@+-]|\\ )+)+/g;

/** A matched absolute-path token: unescaped path plus its literal span in the text. */
export interface AbsolutePathSpan {
  path: string;
  /** Start of the literal match (incl. any `\ ` escapes) in the source text. */
  start: number;
  /** End of the literal match. */
  end: number;
}

/** All distinct existing-file image paths referenced in text (order-preserving). */
export function extractImagePaths(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(IMAGE_RE)) {
    const p = unescape(match[0]);
    if (seen.has(p)) continue;
    if (!isFile(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Distinct existing absolute non-image file paths referenced in text. */
export function extractTextFilePaths(text: string): string[] {
  return [...new Set(absolutePathSpans(text).map((s) => s.path))];
}

/**
 * Existing absolute non-image path tokens with their literal text spans.
 * One greedy regex pass yields disjoint matches, so a span can never be the
 * prefix of another (e.g. /a/b inside /a/b.c); replacement can therefore use
 * the spans directly, right-to-left.
 */
export function absolutePathSpans(text: string): AbsolutePathSpan[] {
  const out: AbsolutePathSpan[] = [];
  for (const match of text.matchAll(ABSOLUTE_PATH_RE)) {
    const p = unescape(match[0]);
    if (/\.(?:png|jpe?g|webp|gif)$/i.test(p)) continue; // images are handled separately
    if (!isFile(p)) continue;
    out.push({ path: p, start: match.index, end: match.index + match[0].length });
  }
  return out;
}

function unescape(p: string): string {
  return p.replace(/\\ /g, " ");
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
