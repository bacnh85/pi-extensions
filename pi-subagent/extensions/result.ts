/**
 * Structured result extraction (parent-side, no child XML contract).
 *
 * Best-effort parsing of a child's final assistant message into sections.
 * Detects markdown headers (## Findings, ## Files, etc.) when present, but
 * degrades gracefully to plain-text summary when they're absent.
 *
 * Deliberately rejects pi-task's <task_result> XML envelope injection
 * (brittle prompt contract). We structure the output ourselves.
 */

export interface StructuredResult {
  /** One-line summary (first non-empty sentence/line, capped). */
  summary: string;
  /** Full raw output, unmodified. */
  fullOutput: string;
  /** Detected "## Findings" / "## Evidence" section, if present. */
  findings?: string;
  /** Detected "## Files" / "## Changed files" section, if present. */
  files?: string;
  /** Detected "## Caveats" / "## Risks" section, if present. */
  caveats?: string;
  /** Detected "## Next steps" / "## Recommendations" section, if present. */
  nextSteps?: string;
}

const SUMMARY_MAX_CHARS = 200;

// Header aliases — case-insensitive, match the heading text after "## ".
const FINDINGS_HEADERS = ["findings", "evidence", "results", "analysis", "details"];
const FILES_HEADERS = ["files", "changed files", "modified files", "changes"];
const CAVEATS_HEADERS = ["caveats", "risks", "limitations", "warnings"];
const NEXT_STEPS_HEADERS = ["next steps", "recommendations", "follow-up", "follow up", "action items"];

/**
 * Parse a raw output string into a StructuredResult.
 * If no markdown headers are found, returns summary + fullOutput only.
 */
export function parseStructuredResult(rawOutput: string): StructuredResult {
  const fullOutput = rawOutput.trim();
  const summary = extractSummary(fullOutput);

  // Split into sections by "## Header" lines.
  const sections = splitByMarkdownHeaders(fullOutput);
  if (Object.keys(sections).length === 0) {
    return { summary, fullOutput };
  }

  const result: StructuredResult = { summary, fullOutput };
  const find = (aliases: string[]): string | undefined => {
    for (const [header, body] of Object.entries(sections)) {
      if (aliases.some((a) => header === a || header.includes(a))) {
        return body.trim() || undefined;
      }
    }
    return undefined;
  };
  const findings = find(FINDINGS_HEADERS);
  const files = find(FILES_HEADERS);
  const caveats = find(CAVEATS_HEADERS);
  const nextSteps = find(NEXT_STEPS_HEADERS);
  if (findings) result.findings = findings;
  if (files) result.files = files;
  if (caveats) result.caveats = caveats;
  if (nextSteps) result.nextSteps = nextSteps;
  return result;
}

/**
 * Extract a one-line summary: first non-empty line that isn't a header,
 * capped to SUMMARY_MAX_CHARS.
 */
export function extractSummary(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip markdown headers.
    if (/^#{1,6}\s/.test(trimmed)) continue;
    // Take the first sentence if it ends with punctuation, else the whole line.
    const sentenceMatch = trimmed.match(/^.+?[.!?](?:\s|$)/);
    const summary = (sentenceMatch ? sentenceMatch[0] : trimmed).trim();
    return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary;
  }
  return text.slice(0, SUMMARY_MAX_CHARS);
}

/**
 * Split markdown into { header: body } sections by "## Header" lines.
 * Text before any header is ignored for section extraction.
 * Returns {} if no headers found.
 */
function splitByMarkdownHeaders(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = text.split("\n");
  let currentHeader: string | null = null;
  let currentBody: string[] = [];
  for (const line of lines) {
    const headerMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headerMatch) {
      if (currentHeader) sections[currentHeader] = currentBody.join("\n");
      currentHeader = headerMatch[1]!.toLowerCase().replace(/[:*_-]/g, "").trim();
      currentBody = [];
    } else if (currentHeader) {
      currentBody.push(line);
    }
  }
  if (currentHeader) sections[currentHeader] = currentBody.join("\n");
  return sections;
}
