// Local headless Chrome capture — for localhost/private/file:// URLs the
// remote Crawl4AI daemon cannot reach (its SSRF protection blocks them).
// Zero dependencies: drives the locally installed Chrome/Chromium binary.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface LocalCapture {
  base64: string;
  mime: string;
  size: number;
}

const CHROME_TIMEOUT_MS = 30_000;
// ponytail: tall-window approximates full page (CLI has no fullPage flag) —
// Playwright tier if this proves insufficient.
const FULL_PAGE_HEIGHT = 8000;

/** Locate a locally installed Chrome/Chromium (or Edge as a Windows fallback). */
export function findChromeBinary(): string | null {
  const candidates: string[] = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  switch (process.platform) {
    case "darwin": {
      const apps = ["/Applications", path.join(process.env.HOME ?? "", "Applications")];
      for (const app of apps) {
        candidates.push(
          path.join(app, "Google Chrome.app/Contents/MacOS/Google Chrome"),
          path.join(app, "Chromium.app/Contents/MacOS/Chromium"),
        );
      }
      break;
    }
    case "win32": {
      const roots = [
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        process.env.LOCALAPPDATA ?? "",
      ].filter(Boolean);
      for (const root of roots) {
        candidates.push(
          path.join(root, "Google\\Chrome\\Application\\chrome.exe"),
          path.join(root, "Microsoft\\Edge\\Application\\msedge.exe"),
        );
      }
      break;
    }
    default: {
      const dirs = [
        ...(process.env.PATH ?? "").split(":").filter(Boolean),
        "/usr/bin",
        "/usr/local/bin",
        "/snap/bin",
      ];
      for (const dir of dirs) {
        candidates.push(
          path.join(dir, "google-chrome"),
          path.join(dir, "google-chrome-stable"),
          path.join(dir, "chromium"),
          path.join(dir, "chromium-browser"),
        );
      }
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** True for URLs a remote daemon provably cannot render: file://, localhost, loopback, private ranges. */
export function isLocalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "file:") return true;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  if (host.includes(":")) {
    // IPv6 ULA fc00::/7 and link-local fe80::/10 are private too.
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    return false;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

/** Daemon SSRF/URL-blocked failures that a local-Chrome retry can rescue. */
export function isSsrfBlocked(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /SSRF|URL blocked/i.test(msg);
}

/** Pick the capture engine: local Chrome or the remote Crawl4AI daemon. */
export function resolveEngine(engine: string | undefined, url: string): "local" | "daemon" {
  if (engine === "local" || engine === "daemon") return engine;
  return isLocalUrl(url) ? "local" : "daemon";
}

export interface ScreenshotArgsOpts {
  chromePath: string;
  outPath: string;
  userDataDir: string;
  url: string;
  width: number;
  height: number;
  fullPage?: boolean;
  waitForSec?: number;
}

export function buildScreenshotArgs(opts: ScreenshotArgsOpts): string[] {
  const height = opts.fullPage ? FULL_PAGE_HEIGHT : opts.height;
  return [
    opts.chromePath,
    "--headless",
    "--no-first-run",
    "--disable-gpu",
    `--user-data-dir=${opts.userDataDir}`,
    "--hide-scrollbars",
    `--window-size=${opts.width},${height}`,
    ...(opts.waitForSec ? [`--virtual-time-budget=${Math.round(opts.waitForSec * 1000)}`] : []),
    `--screenshot=${opts.outPath}`,
    opts.url,
  ];
}

export function buildPdfArgs(opts: {
  chromePath: string;
  outPath: string;
  userDataDir: string;
  url: string;
}): string[] {
  return [
    opts.chromePath,
    "--headless",
    "--no-first-run",
    "--disable-gpu",
    `--user-data-dir=${opts.userDataDir}`,
    "--no-pdf-header-footer",
    `--print-to-pdf=${opts.outPath}`,
    opts.url,
  ];
}

function runChrome(
  args: string[],
  outPath: string,
  signal?: AbortSignal,
  timeoutMs: number = CHROME_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let lastSize = -1;
    let stablePolls = 0;
    let fileTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearInterval(fileTimer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(new Error("Local capture aborted"));
    };
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      // Always a failure: a complete capture is caught earlier by the
      // size-stability poll, so surviving to the timeout means the output
      // never settled (or never appeared) — a file here may be mid-write.
      finish(new Error(`Local capture timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (existsSync(outPath)) finish();
      else finish(new Error(`Chrome exited with code ${code}: ${stderr.slice(-400)}`));
    });
    // Resolve as soon as the capture file is written and stable, then kill —
    // don't require a clean Chrome exit (some versions hang after writing,
    // e.g. fresh --user-data-dir on macOS).
    fileTimer = setInterval(() => {
      if (!existsSync(outPath)) return;
      const size = statSync(outPath).size;
      if (size > 0 && size === lastSize) {
        if (++stablePolls >= 2) {
          child.kill("SIGKILL");
          finish();
        }
      } else {
        stablePolls = 0;
        lastSize = size;
      }
    }, 250);
  });
}

async function readCapture(outPath: string, mime: string): Promise<LocalCapture> {
  const buf = readFileSync(outPath);
  return { base64: buf.toString("base64"), mime, size: buf.length };
}

function assertCaptureUrl(url: string): void {
  // Trust boundary: the URL becomes a spawn argv element — a scheme check
  // keeps strings like "--proxy-server=http://evil" from parsing as switches.
  if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
    throw new Error(`Invalid capture URL (${url.slice(0, 80)}): must be http://, https://, or file://`);
  }
}

export async function captureScreenshot(opts: {
  url: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
  waitForSec?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LocalCapture> {
  assertCaptureUrl(opts.url);
  const chromePath = findChromeBinary();
  if (!chromePath) {
    throw new Error("No local Chrome/Chromium found — install Chrome or set CHROME_PATH.");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "pi-web-capture-"));
  try {
    const outPath = path.join(dir, "screenshot.png");
    await runChrome(
      buildScreenshotArgs({
        chromePath,
        outPath,
        userDataDir: path.join(dir, "profile"),
        url: opts.url,
        width: opts.width ?? 1280,
        height: opts.height ?? 800,
        fullPage: opts.fullPage,
        waitForSec: opts.waitForSec,
      }),
      outPath,
      opts.signal,
      opts.timeoutMs,
    );
    return await readCapture(outPath, "image/png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function capturePdf(opts: {
  url: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LocalCapture> {
  assertCaptureUrl(opts.url);
  const chromePath = findChromeBinary();
  if (!chromePath) {
    throw new Error("No local Chrome/Chromium found — install Chrome or set CHROME_PATH.");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "pi-web-capture-"));
  try {
    const outPath = path.join(dir, "page.pdf");
    await runChrome(
      buildPdfArgs({
        chromePath,
        outPath,
        userDataDir: path.join(dir, "profile"),
        url: opts.url,
      }),
      outPath,
      opts.signal,
      opts.timeoutMs,
    );
    return await readCapture(outPath, "application/pdf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
