import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeContextBreakdown,
  shortSource,
  formatCtxTokens,
  formatCtxPercent,
  ctxWaffle,
  renderContextPanel,
  resolveReserveTokens,
  type ContextBreakdownInput,
} from "../index.ts";

/** Fixture ctx with a structured system-prompt system message + tools. */
function fixtureCtx(overrides: Partial<ContextBreakdownInput["ctx"]> = {}): ContextBreakdownInput["ctx"] {
  const systemSections: Record<string, string | null> = {
    preamble: "p".repeat(400), // 100 tokens
    project_context: "m".repeat(8000), // 2000 tokens
    skills: "<skill><name>a</name></skill>\n<skill><name>b</name></skill>" + "s".repeat(800), // ~204 tokens, 2 skills
    rules: null, // removed section — must be skipped
  };
  const tools = [
    { name: "read", description: "d".repeat(400), parameters: { type: "object" }, sourceInfo: { source: "pi" } },
    { name: "web_search", description: "d".repeat(800), parameters: { type: "object", properties: { q: {} } }, sourceInfo: { source: "@bacnh85/pi-web" } },
    { name: "web_extract", description: "d".repeat(800), parameters: {}, sourceInfo: { source: "@bacnh85/pi-web" } },
  ];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", sections: systemSections },
    { role: "user", content: "u".repeat(200) }, // 50 tokens
    { role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] }, // 100 tokens
  ];
  return {
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
    getSystemPrompt: () => "x".repeat(40000),
    getAllTools: () => tools as never,
    getActiveTools: () => ["read", "web_search"],
    sessionManager: { buildSessionProjection: () => ({ messages }) as never },
    ...overrides,
  };
}

function fixtureInput(overrides: Partial<ContextBreakdownInput> = {}): ContextBreakdownInput {
  const ctx = fixtureCtx();
  const { getAllTools, getActiveTools, ...rest } = ctx as Record<string, unknown>;
  return {
    ctx: rest as unknown as ContextBreakdownInput["ctx"],
    allTools: (getAllTools as () => unknown[])(),
    activeTools: (getActiveTools as () => string[])(),
    ...overrides,
  } as unknown as ContextBreakdownInput;
}

test("formatCtxTokens compact formatting", () => {
  assert.equal(formatCtxTokens(999), "999");
  assert.equal(formatCtxTokens(5340), "5.3K");
  assert.equal(formatCtxTokens(21450), "21K");
  assert.equal(formatCtxTokens(157000), "157K");
  assert.equal(formatCtxTokens(1048576), "1m");
  assert.equal(formatCtxTokens(200000), "200K");
});

test("formatCtxPercent slivers and normal cases", () => {
  assert.equal(formatCtxPercent(328, 1048576), "<0.1%");
  assert.equal(formatCtxPercent(21450, 1048576), "2.0%");
  assert.equal(formatCtxPercent(157000, 1048576), "15.0%");
  assert.equal(formatCtxPercent(500, 0), "?");
});

test("ctxWaffle renders an OMP 4x10 grid that always fills the canvas", () => {
  const grid = ctxWaffle([{ tokens: 21450, glyph: "⛁" }, { tokens: 870000, glyph: "⛶" }, { tokens: 157286, glyph: "⛝" }], 1048576, 10, 4);
  assert.equal(grid.length, 4);
  assert.ok(grid.every((row) => [...row].length === 10), grid.join("|"));
  const flat = grid.join("");
  assert.ok(flat.includes("⛁"), "used cells render ⛁");
  assert.ok(flat.includes("⛶"), "free cells render ⛶");
  assert.ok(flat.includes("⛝"), "autocompact buffer renders ⛝ at the end");
  assert.equal([...flat].length, 40, "exactly rows × cols cells");
  // Buffer is the final slice of the window → painted at the end of the grid.
  assert.equal([...flat].pop(), "⛝");
});

test("ctxWaffle visibility-scales tiny slices to one cell and hands slack to free space", () => {
  // 0.05% used still gets a cell (>=0.5% threshold is one cell either way here);
  // an empty session shows no used cell at all.
  const tiny = ctxWaffle([{ tokens: 500, glyph: "⛁" }, { tokens: 196000, glyph: "⛶" }], 196608).join("");
  assert.equal(tiny.split("⛁").length - 1, 1, "tiny used slice keeps one visible cell");
  const empty = ctxWaffle([{ tokens: 0, glyph: "⛁" }, { tokens: 180224, glyph: "⛶" }, { tokens: 16384, glyph: "⛝" }], 196608).join("");
  assert.equal(empty.split("⛁").length - 1, 0, "zero used renders no filled cells");
  assert.equal(empty.split("⛝").length - 1, 3, "16K/192K buffer ≈ 3 cells");
  assert.equal([...empty].length, 40);
  // Unknown window → all free.
  assert.deepEqual(ctxWaffle([{ tokens: 5, glyph: "⛁" }], 0), Array(4).fill("⛶".repeat(10)));
});

test("resolveReserveTokens mirrors pi's resolution order", () => {
  // default when nothing configured / settings unreadable
  assert.equal(resolveReserveTokens(undefined), 16384);
  assert.equal(resolveReserveTokens({}), 16384);
  // ordinary compaction.reserveTokens
  assert.equal(resolveReserveTokens({ compaction: { reserveTokens: 50000 } }), 50000);
  // per-model override wins over the ordinary value
  assert.equal(
    resolveReserveTokens(
      { compaction: { reserveTokens: 50000, modelOverrides: { "zai/glm-5.3": { reserveTokens: 100000 } } } },
      { provider: "zai", id: "glm-5.3" },
    ),
    100000,
  );
  // invalid values fall back to the default (mirrors pi's validation skip)
  assert.equal(resolveReserveTokens({ compaction: { reserveTokens: -5 } }), 16384);
  assert.equal(resolveReserveTokens({ compaction: { reserveTokens: "big" } }), 16384);
});

test("computeContextBreakdown splits sections, groups tools by source, reserves budget", () => {
  const b = computeContextBreakdown(fixtureInput({ model: { maxTokens: 8192, contextWindow: 200000 } }));
  // System prompt: sections only (blob fallback NOT used), null section skipped.
  // skills string = 59 chars of tags + 800 filler = 859 → 215 tokens.
  assert.equal(b.systemPrompt.total, 100 + 2000 + 215);
  assert.equal(b.systemPrompt.sections.preamble, 100);
  assert.equal(b.systemPrompt.sections.project_context, 2000);
  assert.equal(b.systemPrompt.sections.rules, undefined);
  // Tools: (400 + ~22)/4=106, (800 + ~43)/4=211, 800/4=200 → grouped by source.
  assert.equal(b.tools.registeredCount, 3);
  assert.equal(b.tools.activeCount, 2);
  assert.equal(b.tools.bySource["@bacnh85/pi-web"].count, 2);
  assert.equal(b.tools.bySource.pi.count, 1);
  assert.equal(b.tools.total, b.tools.bySource.pi.tokens + b.tools.bySource["@bacnh85/pi-web"].tokens);
  // Skills parsed from the skills section.
  assert.equal(b.skills.count, 2);
  assert.ok(b.skills.total > 0 && b.skills.total < 300);
  // Memory files: project_context (+ addendum when present).
  assert.equal(b.memoryFiles.total, 2000);
  assert.deepEqual(b.memoryFiles.files.map((f) => f.name), ["project_context"]);
  // Messages: user + assistant, system excluded (counted as systemPrompt).
  assert.equal(b.messages.count, 2);
  assert.equal(b.messages.total, 50 + 100);
  // Per-tool costs, descending (powers the top-tools list).
  assert.deepEqual(b.toolCosts.map((t) => t.name), ["web_search", "web_extract", "read"]);
  // Reserved is the compaction slice only; free space excludes it (pi's trigger:
  // tokens > window - reserveTokens). Model output is NOT reserved.
  assert.deepEqual(b.reserved, { compaction: 16384 });
  assert.equal(b.compactionDisabled, false);
  assert.equal(b.freeSpace, 200000 - 5000 - 16384);
  // Slices are disjoint and account for the window.
  assert.equal(5000 + b.reserved.compaction + b.freeSpace, 200000);
  // Authoritative usage rides through.
  assert.equal(b.usedTokens, 5000);
  assert.equal(b.percent, 2.5);
  assert.equal(b.contextWindow, 200000);
});

test("computeContextBreakdown honors configured reserve and compaction-disabled", () => {
  const configured = computeContextBreakdown(fixtureInput({
    model: { provider: "zai", id: "glm-5.3", maxTokens: 8192, contextWindow: 200000 },
    settings: { compaction: { reserveTokens: 60000, modelOverrides: { "zai/glm-5.3": { reserveTokens: 90000 } } } },
  }));
  assert.equal(configured.reserved.compaction, 90000);
  assert.equal(configured.freeSpace, 200000 - 5000 - 90000);

  const disabled = computeContextBreakdown(fixtureInput({ settings: { compaction: { enabled: false } } }));
  assert.equal(disabled.compactionDisabled, true);
  assert.equal(disabled.freeSpace, 200000 - 5000); // no reserve withheld
});

test("computeContextBreakdown falls back to whole-prompt blob before sections exist", () => {
  const ctx = fixtureCtx();
  ctx.sessionManager.buildSessionProjection = () => ({ messages: [{ role: "user", content: "hi" }] }) as never;
  const b = computeContextBreakdown(fixtureInput({ ctx }));
  assert.equal(b.systemPrompt.total, 10000); // 40000 chars / 4
  assert.equal(b.systemPrompt.sections.skills, undefined);
  assert.equal(b.skills.total, 0);
});

test("computeContextBreakdown tolerates a throwing projection and missing usage", () => {
  const ctx = fixtureCtx({
    // Real after-compaction shape: contextWindow known, tokens null.
    getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }),
  });
  ctx.sessionManager.buildSessionProjection = () => { throw new Error("no session"); };
  const b = computeContextBreakdown(fixtureInput({ ctx }));
  assert.equal(b.usedTokens, null);
  assert.equal(b.percent, null);
  assert.equal(b.systemPrompt.total, 10000);
  // Fallback used-tokens path: system + tools + messages, no throw.
  const lines = renderContextPanel(b);
  assert.ok(lines.some((l) => l.includes("Category splits are estimates")), lines.join("\n"));
  assert.equal(b.freeSpace, Math.max(0, 200000 - (10000 + b.tools.total) - 16384));
});

test("renderContextPanel matches the OMP layout and fires recommendations", () => {
  // Tiny-ish window so the 516-token tool fixture crosses the 40% recommendation threshold.
  const b = computeContextBreakdown(fixtureInput({ ctx: fixtureCtx(), model: { maxTokens: 8192, contextWindow: 1200 } }));
  const lines = renderContextPanel(b);
  assert.equal(lines[0], "Context Usage");
  // Header: 4 waffle rows (10 cells each) with model info on the right.
  const gridRows = lines.slice(2, 6);
  assert.ok(gridRows.every((l) => /^[⛁⛶⛝]{10}/.test(l)), gridRows.join("|"));
  assert.ok(lines.some((l) => l.includes("5.0K/1.2K tokens (416.7%)")), lines.join("\n"));
  // Disjoint, glyph-prefixed category block (core prompt excludes context + skills).
  assert.ok(lines.some((l) => l.startsWith(" ⛁ System prompt:")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith(" ⛁ System tools:")));
  assert.ok(lines.some((l) => l.startsWith(" ⛁ System context:")));
  assert.ok(lines.some((l) => l.startsWith(" ⛁ Skills:")));
  assert.ok(lines.some((l) => l.startsWith(" ⛁ Messages:")));
  assert.ok(lines.some((l) => l.startsWith(" ⛶ Free space:")));
  assert.ok(lines.some((l) => l.startsWith(" ⛝ Autocompact buffer:")));
  // Detail lists.
  assert.ok(lines.some((l) => l.includes("pi-web:")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("@bacnh85/")), "package labels are shortened");
  assert.ok(lines.some((l) => l.includes("project_context: 2.0K")));
  // tools (516) > 40% of the 1200-token window → recommendation fires.
  assert.ok(lines.some((l) => l.startsWith("- ") && l.includes("setActiveTools")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("trimming AGENTS.md")));
});

test("renderContextPanel fires memory + skills recommendations above thresholds", () => {
  const ctx = fixtureCtx();
  const big = "m".repeat(4 * 4000); // 4000 tokens
  (ctx.sessionManager.buildSessionProjection().messages[0] as Record<string, unknown>).sections = {
    project_context: big,
    skills: "<skill><name>a</name></skill>" + "s".repeat(4 * 2500),
  };
  const b = computeContextBreakdown(fixtureInput({ ctx }));
  const lines = renderContextPanel(b);
  assert.ok(lines.some((l) => l.includes("trimming AGENTS.md")));
  assert.ok(lines.some((l) => l.includes("disable-model-invocation")));
});

test("/context handler posts a transcript message; renderer tints glyphs", async () => {
  const { default: extension } = await import("../index.ts");
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const renderers: Record<string, (m: unknown, o: unknown, t: unknown) => { render(w: number): string[] } | undefined> = {};
  const sent: Array<{ customType: string; content: string; display?: boolean; details?: { lines?: string[] } }> = [];
  const fakePi = {
    on: () => {},
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands[name] = def; },
    registerTool: () => {},
    registerMessageRenderer: (type: string, renderer: never) => { renderers[type] = renderer; },
    sendMessage: (msg: { customType: string; content: string; display?: boolean; details?: { lines?: string[] } }) => { sent.push(msg); },
    getAllTools: () => (fixtureCtx() as never as { getAllTools(): unknown[] }).getAllTools(),
    getActiveTools: () => ["read", "web_search"],
  };
  (extension as unknown as (pi: unknown) => void)(fakePi);
  const handler = commands.context?.handler;
  assert.ok(handler, "/context registered");
  assert.ok(renderers["pi-sub-context"], "transcript renderer registered");

  const mkCtx = (mode: string) => ({
    mode,
    model: { maxTokens: 8192, contextWindow: 200000 },
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
    getSystemPrompt: () => "x".repeat(40000),
    sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
    ui: { notify: () => {}, theme: { fg: (_c: string, s: string) => s } },
  });

  // TUI: panel posted as a displayable transcript message carrying the lines.
  await handler!("", mkCtx("tui"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "pi-sub-context");
  assert.equal(sent[0].display, true, "message is displayed in the transcript");
  const lines = sent[0].details?.lines ?? [];
  assert.ok(lines.some((l) => l.startsWith(" ⛁ System prompt:")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith(" ⛶ Free space:")));

  // Renderer: colors the glyph, keeps the body plain, and clamps to width.
  const comp = renderers["pi-sub-context"]!({ details: { lines: [" ⛁ System prompt: 1K tokens (1.0%)"] } }, {}, { fg: (c: string, s: string) => `<${c}>${s}</>` });
  const out = comp!.render(200);
  assert.ok(out[0].includes("<accent>⛁</>"), out[0]);
  assert.ok(out[0].includes("System prompt: 1K tokens"), out[0]);
  // Width clamp applies to the source line (before ANSI codes are added).
  const narrow = comp!.render(10);
  assert.ok(narrow[0].includes("⛁"), "glyph survives the clamp");
  assert.ok(!narrow[0].includes("System prompt"), "body beyond the width is dropped");

  // Plain-text content always rides along as the renderer-less fallback.
  assert.ok(sent[0].content.includes("Context Usage"), "content carries a plain-text fallback");
  assert.ok(sent[0].content.includes("⛁ System prompt:"), sent[0].content);
});

test("categories are disjoint, reconcile with usage, and partition the window", () => {
  const b = computeContextBreakdown(fixtureInput());
  const core = b.categories.find((c) => c.label === "System prompt")!.tokens;
  const context = b.categories.find((c) => c.label === "System context")!.tokens;
  const skills = b.categories.find((c) => c.label === "Skills")!.tokens;
  // No double-counting: core + context + skills reconstruct the system prompt.
  assert.equal(core + context + skills, b.systemPrompt.total);
  // The buffer is a fixed reserve — estimation drift must never inflate it.
  assert.equal(b.categories.find((c) => c.label === "Autocompact buffer")?.tokens, 16384);
  // Whatever the drift sign, the slices always add up to the whole window.
  assert.equal(b.categories.reduce((a, c) => a + c.tokens, 0), b.contextWindow);
});

test("Messages is a residual so no row exceeds the headline total", () => {
  // Authoritative total far above the prompt-side estimates → the difference is
  // real transcript weight and lands on Messages (the residual row).
  const high = computeContextBreakdown(fixtureInput({ ctx: fixtureCtx({ getContextUsage: () => ({ tokens: 60000, contextWindow: 200000, percent: 30 }) }) }));
  const msgsHigh = high.categories.find((c) => c.label === "Messages")!.tokens;
  assert.ok(msgsHigh > 0, "residual messages weight is reported");
  assert.ok(high.categories.every((c) => c.tokens <= high.contextWindow), "no row exceeds the window");
  assert.ok(high.usedTokens! >= msgsHigh, "Messages never exceeds the measured total");
  assert.equal(high.categories.reduce((a, c) => a + c.tokens, 0), 200000, "rows partition the window");

  // Estimates ABOVE the measured total (chars/4 over-counts thinking blocks):
  // the prompt rows stay as measured, Messages floors at 0, no phantom row.
  const low = computeContextBreakdown(fixtureInput({ ctx: fixtureCtx({ getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }) }) }));
  assert.equal(low.categories.find((c) => c.label === "Messages")!.tokens, 0, "residual floors at zero");
  assert.equal(low.categories.reduce((a, c) => a + c.tokens, 0), 200000);
  assert.ok(low.categories.every((c) => c.tokens <= 200000));

  // A stale figure above the window cannot make the partition over-sum.
  const over = computeContextBreakdown(fixtureInput({ ctx: fixtureCtx({ getContextUsage: () => ({ tokens: 999999, contextWindow: 200000, percent: 500 }) }) }));
  assert.equal(over.categories.reduce((a, c) => a + c.tokens, 0), 200000);
});

test("/context handler posts a transcript message; renderer tints glyphs", async () => {
  const { default: extension } = await import("../index.ts");
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const renderers: Record<string, (m: unknown, o: unknown, t: unknown) => { render(w: number): string[] } | undefined> = {};
  const sent: Array<{ customType: string; content: string; display?: boolean; details?: { lines?: string[] } }> = [];
  const fakePi = {
    on: () => {},
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands[name] = def; },
    registerTool: () => {},
    registerMessageRenderer: (type: string, renderer: never) => { renderers[type] = renderer; },
    sendMessage: (msg: { customType: string; content: string; display?: boolean; details?: { lines?: string[] } }) => { sent.push(msg); },
    getAllTools: () => (fixtureCtx() as never as { getAllTools(): unknown[] }).getAllTools(),
    getActiveTools: () => ["read", "web_search"],
  };
  (extension as unknown as (pi: unknown) => void)(fakePi);
  const handler = commands.context?.handler;
  assert.ok(handler, "/context registered");
  assert.ok(renderers["pi-sub-context"], "transcript renderer registered");

  const mkCtx = (mode: string) => ({
    mode,
    model: { maxTokens: 8192, contextWindow: 200000 },
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
    getSystemPrompt: () => "x".repeat(40000),
    sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
    ui: { notify: () => {}, theme: { fg: (_c: string, s: string) => s } },
  });

  // TUI: panel posted as a displayable transcript message carrying the lines.
  await handler!("", mkCtx("tui"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "pi-sub-context");
  assert.equal(sent[0].display, true, "message is displayed in the transcript");
  const lines = sent[0].details?.lines ?? [];
  assert.ok(lines.some((l) => l.startsWith(" ⛁ System prompt:")), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith(" ⛶ Free space:")));

  // Renderer: colors the glyph, keeps the body plain, and clamps to width.
  const comp = renderers["pi-sub-context"]!({ details: { lines: [" ⛁ System prompt: 1K tokens (1.0%)"] } }, {}, { fg: (c: string, s: string) => `<${c}>${s}</>` });
  const out = comp!.render(200);
  assert.ok(out[0].includes("<accent>⛁</>"), out[0]);
  assert.ok(out[0].includes("System prompt: 1K tokens"), out[0]);
  // Width clamp applies to the source line (before ANSI codes are added).
  const narrow = comp!.render(10);
  assert.ok(narrow[0].includes("⛁"), "glyph survives the clamp");
  assert.ok(!narrow[0].includes("System prompt"), "body beyond the width is dropped");

  // Plain-text content always rides along as the renderer-less fallback.
  assert.ok(sent[0].content.includes("Context Usage"), "content carries a plain-text fallback");
  assert.ok(sent[0].content.includes("⛁ System prompt:"), sent[0].content);
});

test("categories are disjoint, reconcile with usage, and partition the window", () => {
  const b = computeContextBreakdown(fixtureInput());
  const core = b.categories.find((c) => c.label === "System prompt")!.tokens;
  const context = b.categories.find((c) => c.label === "System context")!.tokens;
  const skills = b.categories.find((c) => c.label === "Skills")!.tokens;
  // No double-counting: core + context + skills reconstruct the system prompt.
  assert.equal(core + context + skills, b.systemPrompt.total);
  // The buffer is a fixed reserve — estimation drift must never inflate it.
  assert.equal(b.categories.find((c) => c.label === "Autocompact buffer")?.tokens, 16384);
  // Whatever the drift sign, the slices always add up to the whole window.
  assert.equal(b.categories.reduce((a, c) => a + c.tokens, 0), b.contextWindow);
});

test("shortSource reduces local paths and scoped specs to a short label", () => {
  assert.equal(shortSource("../../../../Volumes/Dev/agents/pi-extensions/pi-web"), "pi-web");
  assert.equal(shortSource("@bacnh85/pi-web"), "pi-web");
  assert.equal(shortSource("pi"), "pi");
  assert.equal(shortSource("builtin"), "builtin");
  assert.equal(shortSource(""), "");
});
