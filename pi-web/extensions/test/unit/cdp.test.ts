/**
 * Unit tests for the CDP interaction engine (lib/cdp.ts).
 *
 * Pure helpers are tested directly; runInteraction runs end-to-end against a
 * fake CDP server over a fake websocket (CHROME_PATH points at a stub that
 * writes DevToolsActivePort and hangs) — no real Chrome, no network.
 */

import { expect } from "chai";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildPressEvents,
  CdpConnection,
  readDevToolsPortFile,
  runInteraction,
  unwrapEvaluate,
  validateSteps,
  waitForLoad,
  type StepOutcome,
  type WsLike,
} from "../../lib/cdp";

// ── Fake websocket that speaks just enough CDP for the tests ─────────────

class FakeWs implements WsLike {
  sent: Array<Record<string, any>> = [];
  onSend: ((frame: Record<string, any>) => void) | null = null;
  private listeners = new Map<string, Array<(ev?: { data?: unknown }) => void>>();

  addEventListener(type: string, fn: (ev?: { data?: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
    // A real websocket emits "open" once connected — fake it immediately.
    if (type === "open") queueMicrotask(() => this.emit("open"));
  }
  removeEventListener(type: string, fn: (ev?: { data?: unknown }) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  send(data: string) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (this.onSend) queueMicrotask(() => this.onSend!(frame));
  }
  close() {
    this.emit("close");
  }
  emit(type: string, ev?: { data?: unknown }) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  reply(id: number, result: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify({ id, result }) });
  }
  replyError(id: number, message: string) {
    this.emit("message", { data: JSON.stringify({ id, error: { message } }) });
  }
  event(method: string, params: Record<string, unknown>, sessionId?: string) {
    this.emit("message", { data: JSON.stringify({ method, params, sessionId }) });
  }
}

/** Wire a FakeWs with canned CDP responses for a standard successful run. */
function fakeCdpServer(ws: FakeWs) {
  ws.onSend = (frame) => {
    const { method, id, params } = frame;
    if (method === "Target.createTarget") ws.reply(id, { targetId: "t1" });
    else if (method === "Target.attachToTarget") ws.reply(id, { sessionId: "s1" });
    else if (method === "Page.navigate") {
      ws.reply(id, { frameId: "f1" });
      // Real Chrome fires frameNavigated for the initial main-frame navigation.
      ws.event("Page.frameNavigated", { frame: { url: "http://localhost:3000/" } }, "s1");
      ws.event("Page.loadEventFired", {}, "s1");
    } else if (method === "Runtime.evaluate") {
      const expr = String((params as any)?.expression ?? "");
      if (expr.includes("getBoundingClientRect")) {
        ws.reply(id, { result: { type: "object", value: { x: 100, y: 50 } } });
      } else if (expr.includes("scrollWidth")) {
        ws.reply(id, { result: { type: "string", value: JSON.stringify({ scrollWidth: 390, innerWidth: 390 }) } });
      } else {
        ws.reply(id, { result: { type: "number", value: 2 } });
      }
    } else if (method === "Page.captureScreenshot") {
      ws.reply(id, { data: "UklGRh==" });
    } else {
      ws.reply(id, {});
    }
  };
}

const rejectMsg = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error("expected promise to reject");
};

// ── Pure helpers ─────────────────────────────────────────────────────────

describe("readDevToolsPortFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-web-cdp-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parses port + ws path", () => {
    writeFileSync(path.join(dir, "DevToolsActivePort"), "9222\n/devtools/browser/abc");
    expect(readDevToolsPortFile(dir)).to.deep.equal({ port: 9222, wsPath: "/devtools/browser/abc" });
  });

  it("returns null when the file is missing", () => {
    expect(readDevToolsPortFile(dir)).to.equal(null);
  });

  it("returns null on garbage (file can exist before Chrome fills it)", () => {
    writeFileSync(path.join(dir, "DevToolsActivePort"), "");
    expect(readDevToolsPortFile(dir)).to.equal(null);
    writeFileSync(path.join(dir, "DevToolsActivePort"), "not-a-port\n/x");
    expect(readDevToolsPortFile(dir)).to.equal(null);
  });
});

describe("unwrapEvaluate", () => {
  it("unwraps the nested {result:{result:{value}}} shape", () => {
    expect(unwrapEvaluate({ result: { type: "number", value: 42 } })).to.equal(42);
    expect(unwrapEvaluate({ result: { type: "string", value: "copied" } })).to.equal("copied");
    expect(unwrapEvaluate({ result: { type: "undefined" } })).to.equal(undefined);
  });

  it("surfaces exceptionDetails loudly instead of returning undefined", () => {
    let err: any;
    try {
      unwrapEvaluate({
        result: { type: "object" },
        exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: x is not defined" } },
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(String(err.message)).to.include("x is not defined");
  });
});

describe("buildPressEvents", () => {
  it("maps Enter to keyDown(+text)/keyUp with the right virtual key code", () => {
    const { down, up } = buildPressEvents("Enter");
    expect(down).to.include({ type: "keyDown", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    expect(up).to.include({ type: "keyUp", code: "Enter", windowsVirtualKeyCode: 13 });
    expect(up).to.not.have.property("text");
  });

  it("single characters carry their text; special keys use rawKeyDown", () => {
    const a = buildPressEvents("a");
    expect(a.down).to.include({ type: "keyDown", text: "a", windowsVirtualKeyCode: 65 });
    const tab = buildPressEvents("Tab");
    expect(tab.down).to.include({ type: "rawKeyDown", windowsVirtualKeyCode: 9 });
  });

  it("digits map to Digit codes so e.code gates fire", () => {
    const one = buildPressEvents("1");
    expect(one.down).to.include({ code: "Digit1", windowsVirtualKeyCode: 49, text: "1" });
    expect(buildPressEvents("a").down).to.include({ code: "KeyA" });
  });

  it("rejects unknown multi-character keys", () => {
    expect(() => buildPressEvents("CapsLock")).to.throw(/unsupported key/);
  });

  it('"Space" alias produces identical events to " "', () => {
    expect(buildPressEvents("Space")).to.deep.equal(buildPressEvents(" "));
  });
});

describe("validateSteps", () => {
  it("accepts well-formed steps", () => {
    validateSteps([
      { click: "#btn" },
      { type: { selector: "#name", text: "hi" } },
      { press: "Enter" },
      { evaluate: "1+1", label: "sum" },
      { wait_for: "#done" },
      { wait_for: 250 },
      { dialog: "accept" },
      { dialog: "dismiss" },
      { screenshot: true },
    ]);
  });

  it("rejects zero, multiple, or unknown action keys", () => {
    expect(() => validateSteps([{}] as any)).to.throw(/exactly one action key/);
    expect(() => validateSteps([{ click: "#a", press: "Enter" } as any])).to.throw(/exactly one action key/);
    expect(() => validateSteps([{ scroll: "#a" } as any])).to.throw(/exactly one action key/);
  });

  it("rejects malformed payloads", () => {
    expect(() => validateSteps([{ click: 5 } as any])).to.throw(/selector string/);
    expect(() => validateSteps([{ type: { text: "x" } } as any])).to.throw(/selector, text/);
    expect(() => validateSteps([{ wait_for: true } as any])).to.throw(/selector string or a millisecond number/);
    expect(() => validateSteps([{ dialog: "maybe" } as any])).to.throw(/"accept" or "dismiss"/);
  });
});

describe("CdpConnection over a fake websocket", () => {
  it("matches responses to requests by id and dispatches events to listeners", async () => {
    const ws = new FakeWs();
    const conn = await CdpConnection.connect("ws://fake", () => ws);

    const events: any[] = [];
    conn.on("Page.loadEventFired", (params, sid) => events.push({ params, sid }));

    const p1 = conn.send("Target.createTarget", { url: "about:blank" });
    const p2 = conn.send("Page.navigate", { url: "http://x/" }, "s1");
    ws.reply(1, { targetId: "t1" });
    ws.reply(2, { frameId: "f1" });
    expect(await p1).to.deep.equal({ targetId: "t1" });
    expect(await p2).to.deep.equal({ frameId: "f1" });
    expect(ws.sent[0]).to.include({ method: "Target.createTarget" });
    expect(ws.sent[1]).to.deep.include({ method: "Page.navigate", sessionId: "s1" });

    ws.event("Page.loadEventFired", { frameId: "f1" }, "s1");
    expect(events).to.have.lengthOf(1);
    expect(events[0].sid).to.equal("s1");

    const p3 = conn.send("Runtime.evaluate");
    ws.replyError(3, "Bad params");
    expect(await rejectMsg(p3)).to.match(/Bad params/);

    const p4 = conn.send("Runtime.evaluate");
    ws.close();
    expect(await rejectMsg(p4)).to.match(/closed/);
  });

  it("waitForLoad: orphaned timer rejection is pre-handled (pi-crash regression 2026-09-20)", async () => {
    const ws = new FakeWs();
    const conn = await CdpConnection.connect("ws://fake", () => ws);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    // Deliberately not awaited — simulates Page.navigate rejecting first so the
    // caller skips `await loaded`; the 20ms timer then rejects with no consumer.
    const loaded = waitForLoad(conn, "s1", 20);
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).to.deep.equal([]); // unpatched: contains the timeout Error
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // Normal path intact: awaiting still throws (timeout still surfaces).
    expect(await rejectMsg(loaded)).to.match(/Navigation timed out after 0\.02s/);
  });
});

// ── runInteraction end-to-end against the fake CDP server ────────────────

describe("runInteraction (fake CDP server)", () => {
  let dir: string;
  let originalChromePath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-web-cdp-run-"));
    originalChromePath = process.env.CHROME_PATH;
    // Stub Chrome: publish DevToolsActivePort into the profile dir, then hang.
    const stub = path.join(dir, "stub-chrome.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) prof="\${a#--user-data-dir=}" ;; esac; done\n` +
        `mkdir -p "$prof"\nprintf '9222\\n/devtools/browser/fake' > "$prof/DevToolsActivePort"\nsleep 30\n`,
    );
    chmodSync(stub, 0o755);
    process.env.CHROME_PATH = stub;
  });

  afterEach(() => {
    if (originalChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = originalChromePath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full lifecycle: launch, emulate, navigate, click, evaluate, probe, screenshot", async () => {
    const ws = new FakeWs();
    fakeCdpServer(ws);
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ click: "#btn" }, { evaluate: "1+1", label: "sum" }],
      viewport: { width: 390, height: 844 },
      reducedMotion: true,
      grant: ["clipboard-read"],
      wsFactory: () => ws,
    });

    expect(result.outcomes.map((o) => o.ok)).to.deep.equal([true, true]);
    expect(result.outcomes[1].value).to.equal(2);
    expect(result.screenshot).to.equal("UklGRh==");
    expect(result.probe).to.deep.equal({ scrollWidth: 390, innerWidth: 390 });
    // The initial main-frame navigation must NOT be reported as a step navigation.
    expect(result.navigatedTo).to.be.undefined;

    const methods = ws.sent.map((f) => f.method);
    // Emulation before navigation (honest viewport, no entrance-animation blanks)
    expect(methods.indexOf("Emulation.setDeviceMetricsOverride")).to.be.lessThan(methods.indexOf("Page.navigate"));
    expect(methods.indexOf("Emulation.setEmulatedMedia")).to.be.lessThan(methods.indexOf("Page.navigate"));
    expect(ws.sent.find((f) => f.method === "Emulation.setDeviceMetricsOverride")?.params).to.include({
      width: 390,
      height: 844,
    });
    // Trusted click at the element center over the page session
    const pressed = ws.sent.filter((f) => f.method === "Input.dispatchMouseEvent");
    expect(pressed.map((f) => f.params.type)).to.deep.equal(["mousePressed", "mouseReleased"]);
    expect(pressed[0].params).to.include({ x: 100, y: 50, button: "left" });
    expect(pressed[0].sessionId).to.equal("s1");
    // Permissions granted at browser level (no sessionId), aliased to CDP names
    expect(ws.sent.find((f) => f.method === "Browser.grantPermissions")?.params).to.deep.equal({
      permissions: ["clipboardReadWrite"],
    });
    // No screenshot step → exactly one automatic final capture
    expect(ws.sent.filter((f) => f.method === "Page.captureScreenshot")).to.have.lengthOf(1);
  });

  it("resolves with outcomes + screenshot intact and an empty probe when the probe evaluate fails", async () => {
    const ws = new FakeWs();
    fakeCdpServer(ws);
    const realOnSend = ws.onSend;
    ws.onSend = (frame) => {
      // Probe evaluate (identified by its scrollWidth expression) throws.
      if (frame.method === "Runtime.evaluate" && String(frame.params?.expression ?? "").includes("scrollWidth")) {
        return ws.reply(frame.id, {
          result: { type: "object" },
          exceptionDetails: { text: "Uncaught", exception: { description: "Error: target crashed" } },
        });
      }
      realOnSend(frame);
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ evaluate: "1+1" }],
      wsFactory: () => ws,
    });
    expect(result.outcomes.map((o) => o.ok)).to.deep.equal([true]);
    expect(result.screenshot).to.equal("UklGRh==");
    expect(result.probe).to.deep.equal({});
  });

  it("fails a click on a hidden (zero-size) element instead of clicking at (0,0)", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("getBoundingClientRect")) {
        // The visibility-check expression turns a 0x0 rect into the sentinel.
        return ws.reply(id, { result: { type: "object", value: { hidden: true } } });
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({ url: "http://localhost:3000/", steps: [{ click: "#hidden" }], wsFactory: () => ws });
    expect(result.outcomes[0].ok).to.equal(false);
    expect(result.outcomes[0].error).to.match(/not visible/);
    expect(ws.sent.filter((f) => f.method === "Input.dispatchMouseEvent")).to.have.lengthOf(0);
  });

  it("treats {screenshot:false} as a declined capture (dropped; auto-final still runs)", async () => {
    const ws = new FakeWs();
    fakeCdpServer(ws);
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ screenshot: false } as any],
      wsFactory: () => ws,
    });
    expect(result.outcomes).to.have.lengthOf(0);
    expect(result.screenshot).to.equal("UklGRh==");
    expect(ws.sent.filter((f) => f.method === "Page.captureScreenshot")).to.have.lengthOf(1);
  });

  it("distinguishes a missing element from a non-focusable one on type steps", async () => {
    const run = async (evalValue: unknown): Promise<StepOutcome> => {
      const ws = new FakeWs();
      ws.onSend = (frame) => {
        const { method, id, params } = frame;
        if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
        if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
        if (method === "Page.navigate") {
          ws.reply(id, {});
          ws.event("Page.loadEventFired", {}, "s1");
          return;
        }
        if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("focus")) {
          return ws.reply(id, { result: { type: "object", value: evalValue } });
        }
        ws.reply(id, {});
      };
      const r = await runInteraction({ url: "http://localhost:3000/", steps: [{ type: { selector: "#x", text: "hi" } }], wsFactory: () => ws });
      return r.outcomes[0];
    };
    const missing = await run({ missing: true });
    expect(missing.ok).to.equal(false);
    expect(missing.error).to.match(/no element matches/);
    const notFocusable = await run({ focused: false });
    expect(notFocusable.ok).to.equal(false);
    expect(notFocusable.error).to.match(/not focusable/);
  });

  it("fails fast on a broken step and says why", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate") {
        // click's rect lookup → element missing
        return ws.reply(id, { result: { type: "object", value: null } });
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ click: "#missing" }, { evaluate: "1+1" }],
      wsFactory: () => ws,
    });
    expect(result.outcomes[0].ok).to.equal(false);
    expect(result.outcomes[0].error).to.match(/no element matches #missing/);
    expect(result.outcomes).to.have.lengthOf(1); // stopped, later steps not run
  });

  it("maps the flattened wait_ms schema field onto wait_for", async () => {
    const ws = new FakeWs();
    fakeCdpServer(ws);
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ wait_ms: 10 } as any],
      wsFactory: () => ws,
    });
    expect(result.outcomes.map((o) => o.ok)).to.deep.equal([true]);
    expect(result.outcomes[0].label).to.match(/wait_for 10/);
  });

  it("aliases friendly permission names to CDP names and annotates mid-step navigation", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Browser.grantPermissions") {
        // Capture what actually went over the wire, then ack.
        (ws as any).grantReceived = (params as any).permissions;
        return ws.reply(id, {});
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("1+1")) {
        // The step's evaluate triggers a navigation (form-submit style):
        // first an IFRAME navigates (must be ignored), then the main frame.
        ws.event("Page.frameNavigated", { frame: { url: "http://cdn.example.com/ad", parentId: "f-parent" } }, "s1");
        ws.event("Page.frameNavigated", { frame: { url: "http://localhost:3000/submitted" } }, "s1");
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ evaluate: "1+1" }],
      grant: ["clipboard-read", "clipboard-write"],
      wsFactory: () => ws,
    });
    expect((ws as any).grantReceived).to.deep.equal(["clipboardReadWrite", "clipboardSanitizedWrite"]);
    expect(result.navigatedTo).to.equal("http://localhost:3000/submitted"); // not the iframe URL
  });

  it("ignores iframe/subframe navigations entirely (no false ⚠)", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("scrollWidth")) {
        // An ad iframe refreshes during the probe — subframe, has parentId.
        ws.event("Page.frameNavigated", { frame: { url: "http://cdn.example.com/ad", parentId: "f-parent" } }, "s1");
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({ url: "http://localhost:3000/", steps: [{ evaluate: "1+1" }], wsFactory: () => ws });
    expect(result.navigatedTo).to.be.undefined;
  });

  it("rejects switch-like URLs before launching Chrome", async () => {
    let err: any;
    try {
      await runInteraction({ url: "--remote-debugging-port=9222", wsFactory: () => new FakeWs() });
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(String(err.message)).to.include("Invalid capture URL");
  });

  it("auto-dismisses a native confirm() opened by a click and reports it on the step", async () => {
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("getBoundingClientRect")) {
        // The click's rect lookup: element found at (100, 50).
        return ws.reply(id, { result: { type: "object", value: { x: 100, y: 50 } } });
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        // Real Chrome: the page's onclick called confirm() — renderer blocks until answered.
        ws.event("Page.javascriptDialogOpening", { type: "confirm", message: "Delete this opportunity?" }, "s1");
        return ws.reply(id, {});
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ click: "#delete" }, { evaluate: "1+1", label: "after" }],
      wsFactory: () => ws,
    });
    // Safe default: dismissed (destructive stays blocked)…
    const answer = ws.sent.find((f) => f.method === "Page.handleJavaScriptDialog");
    expect(answer?.params).to.deep.include({ accept: false });
    // …reported on the step and at run level, and the run continued past it.
    expect(result.outcomes[0].dialogs).to.deep.equal(['confirm("Delete this opportunity?") → dismissed']);
    expect(result.dialogs).to.deep.equal(['confirm("Delete this opportunity?") → dismissed']);
    expect(result.outcomes[1].ok).to.equal(true);
  });

  it("answers a dialog with the armed {dialog} step and reverts to dismiss after one consumption", async () => {
    const accepts: boolean[] = [];
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        ws.event("Page.javascriptDialogOpening", { type: "confirm", message: "Delete?" }, "s1");
        return ws.reply(id, {});
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("getBoundingClientRect")) {
        return ws.reply(id, { result: { type: "object", value: { x: 100, y: 50 } } });
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("openAnother")) {
        ws.event("Page.javascriptDialogOpening", { type: "confirm", message: "Again?" }, "s1");
        return ws.reply(id, { result: { type: "number", value: 1 } });
      }
      if (method === "Page.handleJavaScriptDialog") {
        accepts.push(Boolean((params as any).accept));
        return ws.reply(id, {});
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [
        { dialog: "accept" },
        { click: "#delete" },
        { evaluate: "window.openAnother()", label: "second" },
      ] as any,
      wsFactory: () => ws,
    });
    // Armed accept consumed by the first dialog; the second falls back to dismiss.
    expect(accepts).to.deep.equal([true, false]);
    expect(result.outcomes[0].label).to.equal("dialog accept");
    expect(result.dialogs).to.deep.equal(['confirm("Delete?") → accepted', 'confirm("Again?") → dismissed']);
  });

  it("fails a step that exceeds the per-step timeout instead of hanging the run", async () => {
    const ws = new FakeWs();
    let wedged = false;
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      // Simulate a fully wedged renderer (dialog race / hung evaluate): the
      // blocked step AND every post-loop frame (overflow probe, auto-final
      // screenshot) never answer — runInteraction must still resolve.
      if (method === "Runtime.evaluate" && String(params?.expression ?? "") === "blocked") wedged = true;
      if (wedged && (method === "Runtime.evaluate" || method === "Page.captureScreenshot")) return;
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [{ evaluate: "1+1" }, { evaluate: "blocked" }, { evaluate: "1+2" }],
      stepTimeoutMs: 150,
      wsFactory: () => ws,
    });
    expect(result.outcomes).to.have.lengthOf(2); // stopped at the timed-out step
    expect(result.outcomes[0].ok).to.equal(true);
    expect(result.outcomes[1].ok).to.equal(false);
    expect(result.outcomes[1].error).to.match(/timed out after/);
    // Bounded probe + auto-final: the run resolves promptly with outcomes
    // intact, an empty probe, and no PNG (instead of hanging forever).
    expect(result.probe).to.deep.equal({});
    expect(result.screenshot).to.be.undefined;
  });

  it("expires an unconsumed {dialog} arm at the next step boundary", async () => {
    const accepts: boolean[] = [];
    const ws = new FakeWs();
    ws.onSend = (frame) => {
      const { method, id, params } = frame;
      if (method === "Target.createTarget") return ws.reply(id, { targetId: "t1" });
      if (method === "Target.attachToTarget") return ws.reply(id, { sessionId: "s1" });
      if (method === "Page.navigate") {
        ws.reply(id, {});
        ws.event("Page.loadEventFired", {}, "s1");
        return;
      }
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("openAnother")) {
        // An UNRELATED dialog steps after the armed click never happened —
        // the arm must have expired, so this falls back to dismiss.
        ws.event("Page.javascriptDialogOpening", { type: "beforeunload", message: "Leave?" }, "s1");
        return ws.reply(id, { result: { type: "number", value: 1 } });
      }
      if (method === "Page.handleJavaScriptDialog") {
        accepts.push(Boolean((params as any).accept));
        return ws.reply(id, {});
      }
      ws.reply(id, {});
    };
    const result = await runInteraction({
      url: "http://localhost:3000/",
      steps: [
        { dialog: "accept" },
        { evaluate: "1+1", label: "no dialog here" },
        { evaluate: "window.openAnother()", label: "unrelated dialog" },
      ] as any,
      wsFactory: () => ws,
    });
    expect(accepts).to.deep.equal([false]); // NOT accepted
    expect(result.dialogs).to.deep.equal(['beforeunload("Leave?") → dismissed']);
  });
});
