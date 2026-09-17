// Minimal Chrome DevTools Protocol client over Node's native WebSocket —
// zero dependencies. Powers web_interact (trusted click/type/eval/wait/
// screenshot) and honest sub-500px viewport capture: headless Chrome clamps
// --window-size to 500px, but Emulation.setDeviceMetricsOverride is a real
// device-metrics emulation and immune to the clamp.
//
// Traps owned here (incidents from live UX-verify sessions):
// - Runtime.evaluate nests the value at {result:{result:{value}}} — single
//   unwrapping yields undefined and makes the page LOOK broken.
// - Synthetic element.click() grants no user activation, so clipboard writes
//   and other activation-gated APIs fail — clicks go through
//   Input.dispatchMouseEvent at the element's center instead.
// - Targets are created over the websocket (Target.createTarget), never the
//   /json/new HTTP endpoint (PUT-vs-GET drift across Chrome versions).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertCaptureUrl, findChromeBinary } from "./chrome";

const DEVTOOLS_WAIT_MS = 15_000;
const NAVIGATE_TIMEOUT_MS = 15_000;
const WAIT_FOR_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

// ── Connection ────────────────────────────────────────────────────────────

export interface CdpFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string; data?: string };
  sessionId?: string;
}

export interface WsLike {
  addEventListener(type: string, fn: (ev?: { data?: unknown }) => void): void;
  removeEventListener(type: string, fn: (ev?: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export type WsFactory = (url: string) => WsLike;

const defaultWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

export class CdpConnection {
  private ws: WsLike;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>, sessionId?: string) => void>>();
  private closed = false;

  private constructor(ws: WsLike) {
    this.ws = ws;
  }

  static connect(url: string, wsFactory: WsFactory = defaultWsFactory): Promise<CdpConnection> {
    const ws = wsFactory(url);
    return new Promise<CdpConnection>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        const conn = new CdpConnection(ws);
        ws.addEventListener("message", (ev) => conn.handleMessage(String(ev?.data ?? "")));
        ws.addEventListener("close", () => conn.handleClose());
        resolve(conn);
      };
      const onErr = () => {
        cleanup();
        reject(new Error(`Chrome DevTools websocket connection failed (${url})`));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onErr);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onErr);
    });
  }

  private handleClose() {
    this.closed = true;
    for (const [id, p] of this.pending) {
      p.reject(new Error(`Chrome DevTools websocket closed (pending call id ${id})`));
    }
    this.pending.clear();
  }

  private handleMessage(data: string) {
    let msg: CdpFrame;
    try {
      msg = JSON.parse(data) as CdpFrame;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {}, msg.sessionId);
    }
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("Chrome DevTools connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on(method: string, fn: (params: Record<string, unknown>, sessionId?: string) => void): void {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method)!.push(fn);
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ponytail: best-effort close — Chrome gets SIGKILLed right after anyway
    }
  }
}

// ── Launch ────────────────────────────────────────────────────────────────

/** Parse <profile>/DevToolsActivePort: line 1 is the port, line 2 the browser ws path. */
export function readDevToolsPortFile(profile: string): { port: number; wsPath: string } | null {
  const file = path.join(profile, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  const [portLine = "", wsPath = ""] = readFileSync(file, "utf8").trim().split("\n");
  const port = Number(portLine);
  if (!Number.isFinite(port) || port <= 0 || !wsPath) return null;
  return { port, wsPath: wsPath.trim() };
}

export interface CdpBrowser {
  connection: CdpConnection;
  /** Kill Chrome and remove the temp profile. Safe to call more than once. */
  cleanup: () => void;
}

export async function launchCdp(opts: { wsFactory?: WsFactory; devtoolsWaitMs?: number } = {}): Promise<CdpBrowser> {
  if (typeof WebSocket !== "function") {
    throw new Error(
      "Interaction needs Node >= 22 (native WebSocket). Fall back to the manual CDP recipe in the pi-ux ux-capture skill.",
    );
  }
  const chromePath = findChromeBinary();
  if (!chromePath) throw new Error("No local Chrome/Chromium found — install Chrome or set CHROME_PATH.");
  const dir = mkdtempSync(path.join(tmpdir(), "pi-web-cdp-"));
  const profile = path.join(dir, "profile");
  const child = spawn(
    chromePath,
    ["--headless", "--no-first-run", "--disable-gpu", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    // ponytail: SIGKILL without waiting for a clean Chrome exit — some
    // versions hang after writing (fresh --user-data-dir on macOS).
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // ponytail: SIGKILLed Chrome may still write profile files; leftover
        // temp state is cleaned by the OS — never fail the call over it
      }
    }, 300);
  };
  try {
    const wsUrl = await (async () => {
      const deadline = Date.now() + (opts.devtoolsWaitMs ?? DEVTOOLS_WAIT_MS);
      while (Date.now() < deadline) {
        const info = readDevToolsPortFile(profile);
        if (info) return `ws://127.0.0.1:${info.port}${info.wsPath}`;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      throw new Error(`Chrome did not expose a DevTools websocket within ${(opts.devtoolsWaitMs ?? DEVTOOLS_WAIT_MS) / 1000}s`);
    })();
    const connection = await CdpConnection.connect(wsUrl, opts.wsFactory);
    return { connection, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ── Steps ─────────────────────────────────────────────────────────────────

export type InteractStep =
  | { click: string }
  | { type: { selector: string; text: string } }
  | { press: string }
  | { evaluate: string; label?: string }
  | { wait_for: string | number }
  | { screenshot: true };

const STEP_KEYS = ["click", "type", "press", "evaluate", "wait_for", "screenshot"];

/** Exactly one known action key per step, so bad input fails before Chrome launches. */
export function validateSteps(steps: InteractStep[]): void {
  for (const step of steps) {
    const keys = Object.keys(step).filter((k) => STEP_KEYS.includes(k));
    const unknown = Object.keys(step).filter((k) => !STEP_KEYS.includes(k) && k !== "label");
    if (keys.length !== 1 || unknown.length > 0) {
      throw new Error(
        `Each step must have exactly one action key (${STEP_KEYS.join(", ")}); got: ${JSON.stringify(step)}`,
      );
    }
    const key = keys[0];
    if (key === "type" && (typeof (step as any).type !== "object" || !(step as any).type?.selector)) {
      throw new Error(`type step needs { type: { selector, text } }; got: ${JSON.stringify(step)}`);
    }
    if (key === "click" && typeof (step as any).click !== "string") {
      throw new Error(`click step needs a selector string; got: ${JSON.stringify(step)}`);
    }
    if (key === "evaluate" && typeof (step as any).evaluate !== "string") {
      throw new Error(`evaluate step needs an expression string; got: ${JSON.stringify(step)}`);
    }
    if (key === "wait_for" && typeof (step as any).wait_for !== "string" && typeof (step as any).wait_for !== "number") {
      throw new Error(`wait_for step needs a selector string or a millisecond number; got: ${JSON.stringify(step)}`);
    }
  }
}

/** Unwrap Runtime.evaluate's {result:{result:{value}}} — and surface exceptions loudly. */
export function unwrapEvaluate(res: Record<string, unknown>): unknown {
  const inner = (res.result ?? {}) as { value?: unknown; description?: string; subtype?: string };
  const exc = res.exceptionDetails as { text?: string; exception?: { description?: string; value?: unknown } } | undefined;
  if (exc) {
    throw new Error(`evaluate failed: ${exc.exception?.description ?? exc.text ?? "unknown exception"}`);
  }
  return inner.value;
}

interface KeyEvent {
  code: string;
  key: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const KEY_MAP: Record<string, KeyEvent> = {
  Enter: { code: "Enter", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", key: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 },
  " ": { code: "Space", key: " ", windowsVirtualKeyCode: 32, text: " " },
};

/** Map a press step key to CDP keyDown/keyUp descriptors. */
export function buildPressEvents(key: string): { down: Record<string, unknown>; up: Record<string, unknown> } {
  const mapped =
    KEY_MAP[key] ??
    (key.length === 1
      ? {
          code: /^[0-9]$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`,
          key,
          windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
          text: key,
        }
      : null);
  if (!mapped) throw new Error(`press: unsupported key "${key}" (named keys or a single character)`);
  const { text, ...rest } = mapped;
  const down = text ? { type: "keyDown", ...rest, text } : { type: "rawKeyDown", ...rest };
  const up = { type: "keyUp", ...rest };
  return { down, up };
}

export interface StepOutcome {
  label: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  image?: string;
}

function stepLabel(step: InteractStep): string {
  if ("click" in step) return `click ${step.click}`;
  if ("type" in step) return `type "${step.type.text.slice(0, 40)}" into ${step.type.selector}`;
  if ("press" in step) return `press ${step.press}`;
  if ("evaluate" in step) return `evaluate${step.label ? ` (${step.label})` : ""}: ${step.evaluate.slice(0, 80)}`;
  if ("wait_for" in step) return `wait_for ${step.wait_for}`;
  return "screenshot";
}

async function waitForLoad(connection: CdpConnection, sessionId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Register BEFORE navigate so the event can't race past us.
    const onLoaded = (_params: Record<string, unknown>, sid?: string) => {
      if (sid !== sessionId) return;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      reject(new Error(`Navigation timed out after ${NAVIGATE_TIMEOUT_MS / 1000}s`));
    }, NAVIGATE_TIMEOUT_MS);
    connection.on("Page.loadEventFired", onLoaded);
  });
}

async function runStep(
  connection: CdpConnection,
  sessionId: string,
  step: InteractStep,
): Promise<StepOutcome> {
  const label = stepLabel(step);
  try {
    if ("click" in step) {
      const sel = JSON.stringify(step.click);
      const point = unwrapEvaluate(
        await connection.send(
          "Runtime.evaluate",
          {
            expression: `(() => { const el = document.querySelector(${sel}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return { hidden: true }; return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
            returnByValue: true,
          },
          sessionId,
        ),
      ) as { x: number; y: number; hidden?: boolean } | null;
      if (!point) throw new Error(`no element matches ${step.click}`);
      // A zero-size rect (display:none etc.) would put the trusted click at
      // the viewport origin — hitting whatever interactive element lives
      // there WITH user activation while reporting ok. Fail loudly instead.
      if (point.hidden) throw new Error(`element not visible (zero size): ${step.click}`);
      // Trusted input via CDP mouse events — synthetic el.click() grants no
      // user activation (clipboard writes etc. would fail).
      await connection.send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 },
        sessionId,
      );
      await connection.send(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 },
        sessionId,
      );
      return { label, ok: true };
    }
    if ("type" in step) {
      const sel = JSON.stringify(step.type.selector);
      const probe = unwrapEvaluate(
        await connection.send(
          "Runtime.evaluate",
          { expression: `(() => { const el = document.querySelector(${sel}); if (!el) return { missing: true }; el.focus(); return { focused: document.activeElement === el }; })()`, returnByValue: true },
          sessionId,
        ),
      ) as { missing?: boolean; focused?: boolean } | undefined;
      if (!probe || probe.missing) throw new Error(`no element matches ${step.type.selector}`);
      if (!probe.focused) throw new Error(`element is not focusable: ${step.type.selector}`);
      await connection.send("Input.insertText", { text: step.type.text }, sessionId);
      return { label, ok: true };
    }
    if ("press" in step) {
      const { down, up } = buildPressEvents(step.press);
      await connection.send("Input.dispatchKeyEvent", down, sessionId);
      await connection.send("Input.dispatchKeyEvent", up, sessionId);
      return { label, ok: true };
    }
    if ("evaluate" in step) {
      const value = unwrapEvaluate(
        await connection.send(
          "Runtime.evaluate",
          { expression: step.evaluate, returnByValue: true, awaitPromise: true },
          sessionId,
        ),
      );
      return { label, ok: true, value };
    }
    if ("wait_for" in step) {
      if (typeof step.wait_for === "number") {
        await new Promise((r) => setTimeout(r, step.wait_for));
        return { label, ok: true };
      }
      const sel = JSON.stringify(step.wait_for);
      const deadline = Date.now() + WAIT_FOR_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const found = unwrapEvaluate(
          await connection.send(
            "Runtime.evaluate",
            { expression: `!!document.querySelector(${sel})`, returnByValue: true },
            sessionId,
          ),
        );
        if (found) return { label, ok: true };
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      throw new Error(`${step.wait_for} not found within ${WAIT_FOR_TIMEOUT_MS / 1000}s`);
    }
    // screenshot
    const shot = await connection.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const image = shot.data as string;
    return { label, ok: true, image };
  } catch (err) {
    return { label, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────

export interface ViewportOpts {
  width: number;
  height?: number;
  device_scale_factor?: number;
}

const PERMISSION_ALIASES: Record<string, string> = {
  // Friendly names → the only spelling CDP Browser.grantPermissions accepts
  // (it rejects "clipboard-read"/"clipboard-write" outright).
  "clipboard-read": "clipboardReadWrite",
  "clipboard-write": "clipboardSanitizedWrite",
};

export interface InteractionOpts {
  url: string;
  steps?: InteractStep[];
  viewport?: ViewportOpts;
  reducedMotion?: boolean;
  grant?: string[];
  /** Extra settle time after load, seconds (lets staggered reveals finish). */
  waitForSec?: number;
  signal?: AbortSignal;
  wsFactory?: WsFactory;
}

export interface InteractionResult {
  outcomes: StepOutcome[];
  /** Base64 PNG of the last screenshot step (or the automatic final one). */
  screenshot?: string;
  probe: { scrollWidth?: number; innerWidth?: number };
  /** Set when a step triggered a navigation — later steps ran on the NEW document. */
  navigatedTo?: string;
}

/**
 * One call = one browser lifecycle: launch, emulate, navigate, run steps,
 * screenshot + overflow probe, teardown. No session state survives the call.
 */
export async function runInteraction(opts: InteractionOpts): Promise<InteractionResult> {
  assertCaptureUrl(opts.url);
  // Tool-schema shape is flattened (one optional action field per step object)
  // because Z.ai's anthropic-compatible endpoint rejects anyOf nested inside
  // anyOf with 400/1210 — map the split wait_ms field back onto wait_for.
  const steps: InteractStep[] = (opts.steps ?? [])
    .map((s) =>
      (s as { wait_ms?: number }).wait_ms !== undefined ? { wait_for: (s as { wait_ms: number }).wait_ms } : s,
    )
    .filter((s) => (s as { screenshot?: unknown }).screenshot !== false); // {screenshot:false} = declined capture
  validateSteps(steps);
  if (opts.signal?.aborted) throw new Error("Aborted before launch");

  const browser = await launchCdp({ wsFactory: opts.wsFactory });
  const onAbort = () => browser.cleanup();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let sessionId: string | undefined;
  try {
    const connection = browser.connection;
    const target = await connection.send("Target.createTarget", { url: "about:blank" });
    const targetId = target.targetId as string;
    sessionId = ((await connection.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string })
      .sessionId;
    const send = (method: string, params?: Record<string, unknown>) => connection.send(method, params, sessionId);

    // Emulation BEFORE navigation so load-time animations/styling see the
    // emulated environment (honest 390px render, no entrance-animation blanks).
    if (opts.viewport) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: opts.viewport.width,
        height: opts.viewport.height ?? 800,
        deviceScaleFactor: opts.viewport.device_scale_factor ?? 1,
        mobile: false,
      });
    }
    if (opts.reducedMotion) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
    }

    await send("Page.enable");
    const loaded = waitForLoad(connection, sessionId);
    await send("Page.navigate", { url: opts.url });
    await loaded;
    // Track IN-STEP navigations only — registered after the initial load
    // because real Chrome fires frameNavigated for the initial main-frame
    // navigation too, which would false-positive on every run.
    let navigatedTo: string | undefined;
    connection.on("Page.frameNavigated", (params, sid) => {
      if (sid !== sessionId) return;
      const frame = params.frame as { url?: string; parentId?: string } | undefined;
      // Only the MAIN frame (subframes carry a parentId) — an iframe refreshing
      // mid-step is not a page navigation.
      if (!frame || frame.parentId) return;
      const url = frame.url;
      if (url && !url.startsWith("about:")) navigatedTo = url;
    });
    if (opts.waitForSec) await new Promise((r) => setTimeout(r, Math.round(opts.waitForSec * 1000)));
    if (opts.grant?.length) {
      await connection.send("Browser.grantPermissions", {
        permissions: opts.grant.map((p) => PERMISSION_ALIASES[p] ?? p),
      });
    }

    const outcomes: StepOutcome[] = [];
    let screenshot: string | undefined;
    for (const step of steps) {
      opts.signal?.throwIfAborted();
      const outcome = await runStep(connection, sessionId!, step);
      outcomes.push(outcome);
      if (outcome.image) screenshot = outcome.image;
      if (!outcome.ok) break; // fail fast — later steps depend on earlier ones
    }

    // Probe is advisory: a failed readout (ws closed after abort, target
    // crash mid-steps) must never discard collected outcomes or screenshots.
    let probe: { scrollWidth?: number; innerWidth?: number } = {};
    try {
      const probeRaw = unwrapEvaluate(
        await send("Runtime.evaluate", {
          expression: "JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })",
          returnByValue: true,
        }),
      );
      probe = JSON.parse(String(probeRaw));
    } catch {
      // ponytail: advisory — leave probe empty
    }

    if (!screenshot && steps.every((s) => !("screenshot" in s))) {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      screenshot = shot.data as string;
    }

    return { outcomes, screenshot, probe, ...(navigatedTo ? { navigatedTo } : {}) };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    browser.cleanup();
  }
}
