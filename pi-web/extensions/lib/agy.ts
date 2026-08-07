// agy-based web extraction — uses agy's native read_url tool via Gemini/Claude.
// Self-contained: does NOT import from pi-agy (different concern, no coupling).
//
// Runs agy in --mode plan (read-only: no file writes). Verified (agy 1.1.11):
// plan mode auto-approves read_url in headless -p WITHOUT
// --dangerously-skip-permissions, so no broad permission bypass is needed.

import { createRequire } from "node:module";

import { sanitizeError } from "./format";

// ponytail: require (not ESM import) so tests can patch cp.spawn/spawnSync
// without mocking the module graph — same pattern as pi-agy.
const _require = createRequire(import.meta.url);
const cp = _require("node:child_process") as typeof import("node:child_process");

const AGY_FETCH_TIMEOUT_MS = 90_000; // agy needs time for model call + web fetch
const AGY_PROBE_TIMEOUT_MS = 5_000;
const AGY_MAX_OUTPUT_BYTES = 200_000; // bound output to protect Pi context
export const AGY_MODEL = "gemini-3.6-flash-medium"; // ponytail: fixed default; users needing model control use agy_execute

// Cache install status with a TTL — spawnSync blocks the event loop up to
// AGY_PROBE_TIMEOUT_MS, and web_status/extract can call this repeatedly.
let agyInstalledCache: { ok: boolean; at: number } | null = null;
const AGY_INSTALL_CACHE_TTL_MS = 60_000;

export function isAgyInstalled(): boolean {
  if (agyInstalledCache && Date.now() - agyInstalledCache.at < AGY_INSTALL_CACHE_TTL_MS) {
    return agyInstalledCache.ok;
  }
  // ponytail: spawnSync is the simplest reliable probe; result is cached so the
  // event-loop block happens at most once per 60s.
  try {
    const r = cp.spawnSync("agy", ["--version"], { timeout: AGY_PROBE_TIMEOUT_MS, stdio: "ignore" });
    agyInstalledCache = { ok: r.status === 0, at: Date.now() };
    return agyInstalledCache.ok;
  } catch {
    agyInstalledCache = { ok: false, at: Date.now() };
    return false;
  }
}

// Test-only: clear the cached install status.
export function resetAgyInstalledCache(): void {
  agyInstalledCache = null;
}

// Validate + sanitize a URL before it is interpolated into the agy model prompt.
// Prompt-injection guard: reject non-http(s) schemes and strip control chars/newlines
// so a crafted URL cannot break out of the "fetch this URL" framing.
export function sanitizeAgyUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL for agy extraction: ${trimmed.slice(0, 200)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme for agy extraction: ${parsed.protocol}`);
  }
  // Neutralize any control characters/newlines so the URL stays on one line
  // inside the prompt and cannot smuggle instructions.
  return trimmed.replace(/[\x00-\x1f\x7f]/g, "");
}

// Build the agy CLI args for a web-fetch task. Pure — tested without mocking.
export function buildAgyFetchArgs(url: string, prompt?: string, schema?: unknown): string[] {
  const safeUrl = sanitizeAgyUrl(url);
  const structured = prompt || schema !== undefined;
  const jsonInstruction = schema !== undefined
    ? `\nReturn as JSON matching this schema: ${JSON.stringify(schema)}`
    : "\nReturn the result as JSON.";
  const fetchInstruction = structured
    ? (prompt ? `Then extract this information: ${prompt}` : "Then extract the requested fields.") + jsonInstruction
    : "Return the full page content as clean markdown.";

  const agyPrompt = `Use your read_url web tool to fetch this URL: ${safeUrl}\n\n${fetchInstruction}\n\nReturn ONLY the result, no commentary.`;

  return [
    "--model",
    AGY_MODEL,
    "--mode",
    "plan", // read-only: no file writes
    "--print-timeout",
    "90s",
    // Verified (agy 1.1.11): plan mode auto-approves read_url in headless -p
    // WITHOUT --dangerously-skip-permissions — pi-agy's flag is only needed for
    // write modes (accept-edits/sandbox). Omitting it keeps the auto-approval
    // surface at read-only web tools only.
    "--output-format",
    "json", // structured response for clean parsing
    "-p",
    agyPrompt,
  ];
}

export async function extractViaAgy(params: {
  url: string;
  prompt?: string; // structured extraction prompt
  schema?: unknown; // JSON schema for structured extraction
  contentChars?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { url, prompt, schema, contentChars, signal } = params;
  const output = await spawnAgyRaw(buildAgyFetchArgs(url, prompt, schema), signal);
  return parseAgyResponse(output, contentChars ?? 20000);
}

// Parse structured JSON out of agy's model output — used when a prompt/schema was
// requested so the structured result is first-class, matching dynamic mode's
// `structured` field. Handles both fenced (```json ... ```) and bare JSON, which
// the model produces nondeterministically. Pure — tested without mocking.
export function parseAgyStructured(markdown: string): unknown {
  const trimmed = markdown.trim();
  if (!trimmed) return undefined;
  // Fenced block first, then bare JSON object/array.
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```/);
  const candidate = m ? m[1] : trimmed.startsWith("{") || trimmed.startsWith("[") ? trimmed : undefined;
  if (candidate === undefined) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

// Spawn agy with bounded output collection + proper error handling.
async function spawnAgyRaw(args: string[], signal?: AbortSignal): Promise<string> {
  // ponytail: agy is a Go binary in PATH (official installer); no shell wrapper.
  const child = cp.spawn("agy", args, {
    stdio: ["ignore", "pipe", "pipe"],
    signal,
    timeout: AGY_FETCH_TIMEOUT_MS + 5_000, // let agy report its own print timeout first
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  child.stdout.on("data", (d: Buffer) => {
    // Capture all bytes up to the cap, including the partial final chunk
    // (mirrors pi-agy's appendBounded behavior).
    if (stdoutBytes < AGY_MAX_OUTPUT_BYTES) {
      stdout.push(d.subarray(0, AGY_MAX_OUTPUT_BYTES - stdoutBytes));
    }
    stdoutBytes += d.length;
  });
  child.stderr.on("data", (d: Buffer) => {
    stderrBytes += d.length;
    if (stderrBytes <= 16 * 1024) stderr.push(d);
  });

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.on("error", (err: Error) => {
      done(() => {
        if (signal?.aborted) reject(new Error("agy was cancelled"));
        else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("Antigravity CLI (agy) not found in PATH. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash"));
        } else reject(new Error(`agy spawn failed: ${sanitizeError(err)}`));
      });
    });

    child.on("close", (code: number | null, sig: string | null) => {
      done(() => {
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");

        if (sig === "SIGTERM" || sig === "SIGKILL" || code === null) {
          reject(new Error(`agy was cancelled (${sig || "timeout"})`));
        } else if (code !== 0) {
          reject(new Error(`agy exited with code ${code}: ${sanitizeError((err || out).slice(0, 1000).trim() || "(no output)")}`));
        } else {
          // stdout only — stderr may carry warnings that would corrupt JSON envelope parsing
          resolve(out);
        }
      });
    });
  });
}

// Extract .response from agy's JSON envelope, fall back to raw text. Pure — tested without mocking.
export function parseAgyResponse(raw: string, maxChars: number): string {
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.response === "string") text = parsed.response;
    else if (parsed.response !== undefined) text = JSON.stringify(parsed.response);
  } catch {
    // not JSON — use raw
  }
  return text.slice(0, maxChars);
}
