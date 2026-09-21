/**
 * Output truncation for pi-serena.
 * Extracted from index.ts so it can be tested without importing pi-coding-agent.
 */

export const OUTPUT_MAX_BYTES = 50 * 1024;
export const OUTPUT_MAX_LINES = 2_000;

export function truncateText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= OUTPUT_MAX_LINES && Buffer.byteLength(text, "utf8") <= OUTPUT_MAX_BYTES) return text;
  const truncatedLines = lines.slice(0, OUTPUT_MAX_LINES).join("\n");
  const buf = Buffer.from(truncatedLines, "utf8");
  const marker = `\n\n[Serena output truncated to ${OUTPUT_MAX_LINES} lines / ${OUTPUT_MAX_BYTES} bytes.]`;
  if (buf.length <= OUTPUT_MAX_BYTES) return truncatedLines + marker;
  // Find a safe split point that doesn't break a multi-byte character
  let byteLen = OUTPUT_MAX_BYTES;
  while (byteLen > 0 && (buf[byteLen] & 0xc0) === 0x80) byteLen--;
  return buf.subarray(0, byteLen).toString("utf8") + marker;
}
