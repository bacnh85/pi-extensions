/**
 * Tests for pi-attachments: path extraction (incl. prose false-positives),
 * input transform (images, text-file inlining, size cap, no-op, source skip),
 * and clipboard uri-list parsing.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "mocha";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractImagePaths, extractTextFilePaths } from "./lib/paths";
import { parseUriList } from "./lib/clipboard-files";
import { DEFAULTS, loadSettings } from "./lib/settings";
import { lookup, remember, registryPath } from "./lib/registry";
import { savePaste } from "./lib/pastes";
import { AttachmentTray } from "./lib/tray";
import piAttachments from "./index";

const TMP = mkdtempSync(path.join(os.tmpdir(), "pi-attachments-test-"));

// Minimal valid 1x1 PNG (67 bytes, standard test fixture).
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

before(() => {
  // Isolate the persistent token registry (remember()/lookup()) from the real
  // ~/.pi/agent — tests must never write user-visible state.
  // NOTE: mocha runs this root before() before every test in the file — keep
  // registry/env isolation HERE (not in per-describe hooks) so later describes
  // can't accidentally restore-and-delete the override.
  mkdirSync(path.join(TMP, "agent"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = path.join(TMP, "agent");
  writeFileSync(path.join(TMP, "shot.png"), PNG_BYTES);
  writeFileSync(path.join(TMP, "notes.md"), "# Notes\nhello\n");
  writeFileSync(path.join(TMP, "big.md"), "x".repeat(150_000));
});
after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

const img = path.join(TMP, "shot.png");
const md = path.join(TMP, "notes.md");
const big = path.join(TMP, "big.md");

/** Minimal ExtensionAPI double capturing the registered input handler. */
function harness() {
  const handlers: Record<string, Function> = {};
  const shortcuts: Array<{ shortcut: string; options: any }> = [];
  const fake = {
    on: (event: string, handler: Function) => {
      handlers[event] = handler;
    },
    registerShortcut: (shortcut: string, options: any) => shortcuts.push({ shortcut, options }),
  } as any;
  piAttachments(fake);
  return { input: handlers["input"], start: handlers["session_start"], shortcuts };
}

/** Wire session_start (registers terminal-input listener) and capture it. */
function harnessWithPaste(h: ReturnType<typeof harness>) {
  let terminalHandler: Function | undefined;
  h.start({}, { ui: { onTerminalInput: (fn: Function) => (terminalHandler = fn), setWidget: () => {} } });
  return (data: string) => terminalHandler?.(data);
}

const run = async (
  h: ReturnType<typeof harness>,
  text: string,
  source = "interactive",
  images?: Array<{ type: "image"; data: string; mimeType: string }>,
) =>
  (
    (await h.input(
      { type: "input", text, source, ...(images ? { images } : {}) },
      { ui: { getEditorText: () => text, setWidget: () => {} } },
    )) ?? { action: "continue" }
  );


describe("extractImagePaths", () => {
  it("finds existing image paths, deduped", () => {
    assert.deepEqual(extractImagePaths(`look at ${img} and ${img}`), [img]);
  });

  it("ignores nonexistent image paths", () => {
    assert.deepEqual(extractImagePaths("see /tmp/definitely-missing-xyz.png here"), []);
  });

  it("prose false-positives produce zero matches", () => {
    assert.deepEqual(extractImagePaths("the .jpg extension is common"), []);
    assert.deepEqual(extractImagePaths("rename file png to webp"), []);
    assert.deepEqual(extractImagePaths("output: 'quoted.png' stays unquoted"), []);
  });

  it("matches paths with escaped spaces (terminal drop form)", () => {
    const spaced = path.join(TMP, "with space.png");
    writeFileSync(spaced, PNG_BYTES);
    const escaped = spaced.replace(/ /g, "\\ "); // Terminal.app pastes "with\ space.png"
    assert.deepEqual(extractImagePaths(`dropped ${escaped}`), [spaced]);
  });
});

describe("extractTextFilePaths", () => {
  it("finds existing absolute text paths, skips images and missing files", () => {
    assert.deepEqual(extractTextFilePaths(`read ${md} and ${img} and /no/such/file.md`), [md]);
  });

  it("never matches relative prose mentions", () => {
    assert.deepEqual(extractTextFilePaths("see main.rs or src/lib.ts for details"), []);
  });
});

describe("parseUriList", () => {
  it("parses file URIs and percent-decodes spaces", () => {
    assert.deepEqual(parseUriList("file:///tmp/a%20b.png\r\ncopy\nfile:///tmp/c.md"), ["/tmp/a b.png", "/tmp/c.md"]);
  });

  it("ignores non-file lines and malformed uris", () => {
    assert.deepEqual(parseUriList("copy\nhttps://x.com/y\nfile://\nfile:///tmp/ok.md"), ["/tmp/ok.md"]);
  });
});

describe("loadSettings", () => {
  it("returns defaults when settings file is absent", () => {
    // Don't touch PI_CODING_AGENT_DIR here: the root after() restores it.
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(TMP, "no-such-dir");
    try {
      assert.deepEqual(loadSettings(), DEFAULTS);
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });

  it("reads the attachments key and falls back per-field", () => {
    const dir = path.join(TMP, "cfg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ attachments: { maxInlineBytes: 5 } }));
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const s = loadSettings();
      assert.equal(s.maxInlineBytes, 5);
      assert.equal(s.inlineTextFiles, DEFAULTS.inlineTextFiles);
      assert.equal(s.pasteFileShortcut, DEFAULTS.pasteFileShortcut);
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });
});

describe("registry persistence", () => {
  it("remember() creates a fresh agent dir and an atomic, parseable registry file", () => {
    const dir = path.join(TMP, "fresh-agent");
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      remember("fresh.md", "/tmp/fresh.md");
      assert.equal(lookup("fresh.md"), "/tmp/fresh.md");
      const raw = JSON.parse(readFileSync(registryPath(), "utf-8"));
      assert.equal(raw["fresh.md"], "/tmp/fresh.md");
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });
});

describe("AttachmentTray", () => {
  it("adds, renders, expands, prunes, clears", () => {
    const tray = new AttachmentTray();
    const a = tray.add("/tmp/a.png");
    const b = tray.add("/tmp/b.md");
    assert.equal(tray.size, 2);
    assert.equal(a.token, "[[attach:a.png]]");
    assert.equal(b.token, "[[attach:b.md]]");
    assert.deepEqual(tray.render(), ["📎 a.png · b.md"]);
    const expanded = tray.expand(`look ${a.token} and ${b.token}`);
    assert.equal(expanded, "look /tmp/a.png and /tmp/b.md");
    assert.deepEqual(tray.resolve(`look ${a.token} and ${b.token}`), [a, b]);
    tray.prune(`only ${a.token} left`);
    assert.deepEqual(tray.render(), ["📎 a.png"]);
    assert.deepEqual(tray.resolve(`${a.token} x`), [a]);
    tray.clear();
    assert.equal(tray.size, 0);
    assert.deepEqual(tray.render(), []);
  });

  it("same-basename files get unique token names", () => {
    const tray = new AttachmentTray();
    const a = tray.add("/tmp/dir1/demo.jpeg");
    const b = tray.add("/tmp/dir2/demo.jpeg");
    assert.equal(a.token, "[[attach:demo.jpeg]]");
    assert.equal(b.token, "[[attach:demo-2.jpeg]]");
    assert.ok(tray.expand(`${a.token} ${b.token}`).includes("/tmp/dir2/demo.jpeg"));
  });
});

let inlineDirCounter = 0;

/** 0.3.1: session_start re-reads settings — keep a temp PI_CODING_AGENT_DIR
 *  active through start (and input for start-less runs); restore after first use. */
function keepSettingsThrough(h: ReturnType<typeof harness>, saved: string | undefined): ReturnType<typeof harness> {
  const restore = () => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  };
  let restored = false;
  const once = () => { if (!restored) { restored = true; restore(); } };
  const realStart = h.start;
  h.start = (event: unknown, ctx: unknown) => {
    try { return realStart(event, ctx); } finally { once(); }
  };
  const realInput = h.input;
  h.input = (event: unknown, ctx: unknown) => {
    try { return realInput(event, ctx); } finally { once(); }
  };
  return h;
}

/** Harness whose piAttachments() sees inlineTextFiles: true via a temp settings dir. */
function inlineHarness() {
  const dir = path.join(TMP, `inline-${inlineDirCounter++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ attachments: { inlineTextFiles: true, pasteCollapseLines: 10 } }),
  );
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  return keepSettingsThrough(harness(), saved);
}

describe("input transform", () => {
  it("converts an existing image path into an ImageContent part", async () => {
    const result = await run(harness(), `what is in ${img}?`);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, "image/png");
    assert.equal(Buffer.from(result.images[0].data, "base64").length, PNG_BYTES.length);
    assert.ok(result.text.includes(img)); // path text kept as reference
  });

  it("inlines small text files as <file> blocks (inlineTextFiles opt-in)", async () => {
    const result = await run(inlineHarness(), `summarize ${md}`);
    assert.equal(result.action, "transform");
    assert.ok(result.text.includes(`<file name="${md}">\n# Notes\nhello\n</file>`));
    assert.ok(!result.text.includes(`summarize ${md}`));
  });

  it("default mode: typed text path is left as a bare path (no inline, no token)", async () => {
    const result = await run(harness(), `summarize ${md}`);
    assert.equal(result.action, "continue");
  });

  it("default mode: dropped-text-file token resolves to a 📎 path, no content dump", async () => {
    remember("cookies.txt", "/Users/bacnh/Downloads/medium.com_cookies.txt");
    const h = harness();
    const result = await run(h, `what is in [[attach:cookies.txt]] ?`);
    assert.equal(result.action, "transform");
    assert.ok(result.text.includes("📎 /Users/bacnh/Downloads/medium.com_cookies.txt"));
    assert.ok(!result.text.includes("<file"), "no content block");
    assert.ok(!result.text.includes("[[attach:"), "token resolved");
  });

  it("substring paths don't corrupt each other (inline mode)", async () => {
    const bak = md + ".bak";
    writeFileSync(bak, "backup content\n");
    const result = await run(inlineHarness(), `compare ${md} with ${bak}`);
    assert.equal(result.action, "transform");
    assert.ok(result.text.includes(`<file name="${md}">`), "shorter path inlined");
    assert.ok(result.text.includes(`<file name="${bak}">`), "longer path inlined intact");
    assert.ok(result.text.includes("backup content"));
    const blocks = result.text.match(/<file name="[^"]+">[\s\S]*?<\/file>/g) ?? [];
    assert.equal(blocks.length, 2, "exactly two blocks, no nesting");
  });

  it("skips text files over the size cap (inline mode)", async () => {
    const result = await run(inlineHarness(), `read ${big}`);
    assert.equal(result.action, "continue");
    assert.ok(!result.text?.includes("<file"), "oversized file is not inlined");
  });

  it("no-op for plain prose", async () => {
    assert.equal((await run(harness(), "hello there, no paths here")).action, "continue");
  });

  it("skips extension-sourced input", async () => {
    const h = harness();
    assert.ok(!(await h.input({ type: "input", text: `check ${img}`, source: "extension" }, {} as any)));
  });

  it("token from a PREVIOUS session resolves via the persistent registry", async () => {
    // Simulate: file dropped in an earlier session (registry written), tray now empty.
    remember("custom-footer.ts", "/Users/bacnh/Downloads/custom-footer.ts");
    assert.equal(lookup("custom-footer.ts"), "/Users/bacnh/Downloads/custom-footer.ts");

    // Fresh extension load (new session) — tray is empty but registry knows the file.
    const h = harness();
    const result = await run(h, "what is [[attach:custom-footer.ts]] ?");
    assert.equal(result.action, "transform");
    assert.ok(result.text.includes("/Users/bacnh/Downloads/custom-footer.ts"), "token expanded via registry");
    assert.ok(!result.text.includes("[[attach:"), "no dead token left");
  });

  it("registers the paste-file shortcut", () => {
    const h = harness();
    assert.equal(h.shortcuts.length, 1);
    assert.equal(h.shortcuts[0].shortcut, DEFAULTS.pasteFileShortcut);
  });

  it("path-only bracketed paste is rewritten to attachment tokens", () => {
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const result = onPaste(`\x1b[200~${img} ${path.join(TMP, "notes.md")}\x1b[201~`) as any;
    assert.ok(result?.data);
    const tokens = result.data.split(" ");
    assert.equal(tokens.length, 2);
    assert.match(tokens[0], /^\[\[attach:[^\]]+\]\]$/);
    // tokens expand back to real paths at submit → images/text inline as usual
  });

  it("directory paste passes through untouched (no token, no chip)", () => {
    const dir = path.join(TMP, "dropped-dir");
    mkdirSync(dir, { recursive: true });
    const spacedDir = path.join(TMP, "spaced dir");
    mkdirSync(spacedDir, { recursive: true });
    const h = harness();
    const onPaste = harnessWithPaste(h);
    assert.equal(onPaste(`\x1b[200~${dir}\x1b[201~`), undefined);
    assert.equal(
      onPaste(`\x1b[200~${spacedDir.replace(/ /g, "\\ ")}\x1b[201~`),
      undefined,
      "escaped-space directory passes through",
    );
  });

  it("mixed file + directory paste tokenizes only the file", () => {
    const dir = path.join(TMP, "mixed-dir");
    mkdirSync(dir, { recursive: true });
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const result = onPaste(`\x1b[200~${img} ${dir}\x1b[201~`) as any;
    assert.ok(result?.data);
    const [token, literal] = result.data.split(" ");
    assert.match(token, /^\[\[attach:shot\.png\]\]$/);
    assert.equal(literal, dir, "directory stays literal text");
  });

  it("mixed paste with an escaped-space directory keeps the escaped literal", () => {
    const spacedDir = path.join(TMP, "mixed spaced dir");
    mkdirSync(spacedDir, { recursive: true });
    const escaped = spacedDir.replace(/ /g, "\\ ");
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const result = onPaste(`\x1b[200~${img} ${escaped}\x1b[201~`) as any;
    assert.ok(result?.data);
    assert.ok(result.data.startsWith("[[attach:shot.png]] "), "file tokenized");
    assert.ok(result.data.endsWith(escaped), "escaped directory kept verbatim");
  });

  it("mixed file + directory paste survives submit: dir literal, file attached", async () => {
    const dir = path.join(TMP, "submit-dir");
    mkdirSync(dir, { recursive: true });
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const pasted = onPaste(`\x1b[200~${img} ${dir}\x1b[201~`) as any;
    const result = await run(h, pasted.data);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 1, "file attached as image");
    assert.ok(result.text.includes(dir), "directory stays literal text");
    assert.ok(!result.text.includes("[[attach:"), "no dead token left");
  });

  it("inline mode: mixed paste submits to exactly one <file> block + literal dir", async () => {
    const dir = path.join(TMP, "inline-mixed-dir");
    mkdirSync(dir, { recursive: true });
    const h = inlineHarness();
    const onPaste = harnessWithPaste(h);
    const pasted = onPaste(`\x1b[200~${path.join(TMP, "notes.md")} ${dir}\x1b[201~`) as any;
    const result = await run(h, pasted.data);
    assert.equal(result.action, "transform");
    assert.equal((result.text.match(/<file name="/g) ?? []).length, 1, "exactly one <file> block");
    assert.ok(!result.text.includes('<file name="<file'), "no nested <file> block");
    assert.ok(result.text.includes(dir), "directory stays literal");
  });

  it("mixed text paste passes through untouched", () => {
    const h = harness();
    const onPaste = harnessWithPaste(h);
    assert.equal(onPaste("\x1b[200~hello world /tmp\x1b[201~"), undefined);
    assert.equal(onPaste("plain keys"), undefined);
  });

  it("token flow: pasted tokens expand to real content at submit", async () => {
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const pasted = onPaste(`\x1b[200~${img}\x1b[201~`) as any;
    const token = pasted.data.trim();
    const result = await run(h, `what is ${token}?`);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 1);
    assert.ok(result.text.includes(img), "expanded to the real path");
    assert.ok(!result.text.includes(token), "token replaced");
  });

  it("basename containing ] is attached on submit (no dead token)", async () => {
    const weird = path.join(TMP, "we]ird.png");
    writeFileSync(weird, PNG_BYTES);
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const pasted = onPaste(`\x1b[200~${weird}\x1b[201~`) as any;
    const result = await run(h, pasted.data.trim());
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 1, "image attached");
    assert.ok(result.text.includes(weird), "resolved to the real path");
    assert.ok(!result.text.includes("[[attach:"), "no dead token left");
  });

  it("escaped-space path drop becomes a token and resolves to the real path", async () => {
    const spaced = path.join(TMP, "with space.png");
    writeFileSync(spaced, PNG_BYTES);
    const escaped = spaced.replace(/ /g, "\\ "); // Terminal.app drop form
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const pasted = onPaste(`\x1b[200~${escaped}\x1b[201~`) as any;
    assert.equal(pasted.data, "[[attach:with space.png]]");
    const result = await run(h, `what is ${pasted.data}?`);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 1);
    assert.ok(result.text.includes(spaced), "token resolved to the unescaped path");
  });

  it("same image via two tokens is attached only once", async () => {
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const pasted = onPaste(`\x1b[200~${img} ${img}\x1b[201~`) as any;
    const [t1, t2] = pasted.data.split(" ");
    assert.notEqual(t1, t2, "second drop gets a unique token");
    const result = await run(h, `${t1} ${t2}`);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 1, "duplicate path attached once");
    assert.equal((result.text.match(/📎/g) ?? []).length, 2, "both tokens replaced by the path chip");
  });

  it("preserves pre-existing event images when adding discovered ones", async () => {
    const prior = { type: "image" as const, data: "UVp", mimeType: "image/png" };
    const result = await run(harness(), `what is in ${img}?`, "interactive", [prior]);
    assert.equal(result.action, "transform");
    assert.equal(result.images.length, 2);
    assert.equal(result.images[0].data, "UVp", "original event image kept first");
    assert.equal(result.images[1].mimeType, "image/png", "discovered image appended");
  });

  it("escaped-space text path is inlined like its image counterpart (inline mode)", async () => {
    const spaced = path.join(TMP, "with space.md");
    writeFileSync(spaced, "spaced content\n");
    const escaped = spaced.replace(/ /g, "\\ ");
    const result = await run(inlineHarness(), `summarize ${escaped}`);
    assert.equal(result.action, "transform");
    assert.ok(result.text.includes(`<file name="${spaced}">\nspaced content\n</file>`));
  });

  it("inline mode: dropped text-file token inlines exactly once (no nested <file>)", async () => {
    const h = inlineHarness();
    const onPaste = harnessWithPaste(h);
    const pasted = onPaste(`\x1b[200~${path.join(TMP, "notes.md")}\x1b[201~`) as any;
    const result = await run(h, pasted.data.trim());
    assert.equal(result.action, "transform");
    assert.equal((result.text.match(/<file name="/g) ?? []).length, 1, "exactly one <file> block");
    assert.ok(!result.text.includes('<file name="<file'), "no nested <file> block");
  });
});

describe("attachment removal flow", () => {
  function fullHarness() {
    const handlers: Record<string, Function> = {};
    let widget: string[] | null = null;
    let pasteHandler: Function | undefined;
    let editorText = "";
    const ui = {
      onTerminalInput: (fn: Function) => { pasteHandler = fn; },
      setWidget: (_key: string, lines: string[]) => { widget = lines; },
      getEditorText: () => editorText,
    };
    piAttachments({ on: (e: string, h: Function) => { handlers[e] = h; }, registerShortcut: () => {} } as any);
    handlers["session_start"]({}, { ui });
    return {
      paste: (data: string) => pasteHandler?.(data),
      type: (t: string) => { editorText = t; pasteHandler?.("x"); }, // any keystroke syncs
      submit: () => handlers["input"]({ type: "input", text: editorText, source: "interactive" }, { ui }),
      get widget() { return widget; },
    };
  }

  it("deleting a token from the prompt removes its chip and its attachment", async () => {
    writeFileSync("/tmp/rm-a.png", PNG_BYTES);
    writeFileSync("/tmp/rm-b.txt", "b\n");
    const h = fullHarness();

    const pasted: any = h.paste("\x1b[200~/tmp/rm-a.png /tmp/rm-b.txt\x1b[201~");
    const tokenA = pasted.data.split(" ")[0];
    const tokenB = pasted.data.split(" ")[1];
    h.type(pasted.data);
    assert.ok(h.widget![0].includes("·"), "both chips shown");

    // user deletes the second token → next keystroke prunes its chip
    h.type(`${tokenA} look`);
    assert.equal(h.widget!.length, 1, "single chip line");
    assert.ok(h.widget![0].includes("rm-a.png"));
    assert.ok(!h.widget![0].includes("rm-b.txt"), "removed chip is gone");

    // submit sends only the surviving image
    const result: any = await h.submit();
    assert.equal(result.images.length, 1);
    assert.ok(!result.text.includes("rm-b"), "removed file is not attached");
    assert.ok(!result.text.includes(tokenB), "removed token is gone");
  });
});

describe("paste collapse", () => {
  const wrap = (payload: string) => `\x1b[200~${payload}\x1b[201~`;
  const logWall = (n: number) => Array.from({ length: n }, (_, i) => `log line ${i}`).join("\n");

  it("large multi-line paste collapses to a paste file + token, resolved read-on-demand", async () => {
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const payload = logWall(15);
    const pasted: any = onPaste(wrap(payload));
    assert.ok(pasted?.data?.startsWith("[[attach:paste_"), "editor receives one paste token");
    assert.ok(!pasted.data.includes("log line"), "payload not inlined into the editor");

    const result: any = await run(h, pasted.data);
    assert.equal(result.action, "transform");
    const m = result.text.match(/📎 (\S*paste_\d+_\d{6}_\d+\.txt) \(pasted text, 15 lines\)/);
    assert.ok(m, "resolves to the paste path with line-count hint");
    assert.ok(!result.text.includes("log line 3"), "content is not re-inlined");
    assert.equal(readFileSync(m![1], "utf-8"), payload, "paste file holds the payload");
  });

  it("short paste passes through untouched", () => {
    const onPaste = harnessWithPaste(harness());
    assert.equal(onPaste(wrap("just one line")), undefined);
  });

  it("char threshold collapses one-line walls (minified JSON)", () => {
    const onPaste = harnessWithPaste(harness());
    const pasted: any = onPaste(wrap(JSON.stringify({ pad: "x".repeat(2500) })));
    assert.ok(pasted?.data?.startsWith("[[attach:paste_"));
  });

  it("slash-command editor text passes through", () => {
    const h = harness();
    let pasteHandler: Function | undefined;
    h.start({}, { ui: { onTerminalInput: (fn: Function) => (pasteHandler = fn), setWidget: () => {}, getEditorText: () => "/review " } });
    assert.equal(pasteHandler?.(wrap(logWall(15))), undefined);
  });

  it("pasteCollapseLines/pasteCollapseChars: 0 disables collapse", () => {
    const dir = path.join(TMP, "collapse-off");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ attachments: { pasteCollapseLines: 0, pasteCollapseChars: 0 } }));
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    // keepSettingsThrough: session_start re-reads settings, so the override
    // must stay active through start.
    const h = keepSettingsThrough(harness(), saved);
    const onPaste = harnessWithPaste(h);
    assert.equal(onPaste(wrap(logWall(15))), undefined);
  });

  it("savePaste sweeps oldest files beyond the cap", () => {
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(TMP, "sweep-agent");
    try {
      const a = savePaste("a");
      utimesSync(a, new Date(1000), new Date(1000)); // force oldest mtime
      const b = savePaste("b");
      const c = savePaste("c", 2);
      assert.ok(!existsSync(a), "oldest swept");
      assert.ok(existsSync(b) && existsSync(c), "newer pastes kept");
      const dir = path.join(TMP, "sweep-agent", "pastes");
      assert.equal(readdirSync(dir).filter((f) => /^paste_\d+_\d{6}_\d+\.txt$/.test(f)).length, 2);
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });

  it("pid-suffixed filenames: two saves in the same second never collide", () => {
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(TMP, "pid-agent");
    try {
      const a = savePaste("first payload");
      const b = savePaste("second payload");
      assert.equal(statSync(a).mode & 0o777, 0o600, "paste files are owner-only");
      assert.notEqual(a, b, "distinct paths");
      assert.equal(readFileSync(a, "utf-8"), "first payload");
      assert.equal(readFileSync(b, "utf-8"), "second payload");
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });

  it("inlineTextFiles does not re-inline a collapsed paste (read-on-demand kept)", async () => {
    const h = inlineHarness();
    const onPaste = harnessWithPaste(h);
    const pasted: any = onPaste(wrap(logWall(15)));
    assert.ok(pasted?.data?.startsWith("[[attach:paste_"));
    const result: any = await run(h, pasted.data);
    assert.equal(result.action, "transform");
    assert.match(result.text, /📎 \S*paste_\d+_\d{6}_\d+\.txt \(pasted text, 15 lines\)/);
    assert.ok(!result.text.includes("<file"), "no <file> block — paste stays read-on-demand");
  });

  it("CRLF paste is normalized to LF on disk and in the line-count hint", async () => {
    const h = harness();
    const onPaste = harnessWithPaste(h);
    const lf = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n");
    const pasted: any = onPaste(wrap(lf.replace(/\n/g, "\r\n")));
    assert.ok(pasted?.data?.startsWith("[[attach:paste_"));
    const result: any = await run(h, pasted.data);
    const m = result.text.match(/📎 (\S*paste_\d+_\d{6}_\d+\.txt) \(pasted text, 15 lines\)/);
    assert.ok(m, "hint counts normalized lines");
    const saved = readFileSync(m![1], "utf-8");
    assert.equal(saved, lf, "file content is LF-normalized");
    assert.ok(!saved.includes("\r"), "no stray \\r anywhere");
  });

  it("disk failure degrades gracefully: no throw, paste passes through untouched", () => {
    // TMP/not-a-dir is a regular FILE, so <agentDir>/pastes mkdirSync throws
    // ENOTDIR deterministically (even as root).
    writeFileSync(path.join(TMP, "not-a-dir"), "i am a file");
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(TMP, "not-a-dir", "sub");
    try {
      const h = harness(); // settings load at registration
      const onPaste = harnessWithPaste(h);
      let result: any;
      assert.doesNotThrow(() => {
        result = onPaste(wrap(logWall(15)));
      });
      assert.equal(result, undefined, "paste passes through to the editor");
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });

  it("unwritable agent dir: file drop degrades gracefully, no crash", () => {
    // remember() in the path-drop branch must not throw either — pi-tui has no
    // try/catch around terminal-input listeners.
    writeFileSync(path.join(TMP, "not-a-dir"), "i am a file");
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(TMP, "not-a-dir", "sub");
    try {
      const onPaste = harnessWithPaste(harness());
      let result: any;
      assert.doesNotThrow(() => {
        result = onPaste(wrap(img));
      });
      assert.ok(result?.data?.startsWith("[[attach:"), "token still produced, just not persisted");
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });

  it("inlineTextFiles does not re-inline a prior-session paste token", async () => {
    const h = inlineHarness();
    // Simulate a paste registered in an earlier session: the paste file persists
    // on disk, the registry maps token name → path, the tray is session-local
    // (empty here).
    const priorPaste = path.join(TMP, "paste_1_120000_999.txt");
    writeFileSync(priorPaste, "old paste body\n");
    remember("paste_1_120000_999.txt", priorPaste);
    const result: any = await run(h, "[[attach:paste_1_120000_999.txt]]");
    assert.equal(result.action, "transform");
    assert.match(result.text, /📎 \S*paste_1_120000_999\.txt/);
    assert.ok(!result.text.includes("<file"), "paste stays read-on-demand across restarts");
  });
});
