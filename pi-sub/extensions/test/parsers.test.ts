import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandCodeWindowToUsageWindow,
  parseEnvText,
  parseOmniUsageText,
  routerUpstreamPrefix,
  tokPerSecLabel,
} from "../index.ts";

// ── parseOmniUsageText — OmniRoute /api/usage/om-usage free-text report ──────

test("om-usage: full report parses all four windows", () => {
  const p = parseOmniUsageText(
    [
      "Personal quota",
      "Daily",
      "80% left",
      "⏱ reset in 15h 0m",
      "",
      "Weekly",
      "90% left",
      "⏱ reset in 7d 0h 0m",
      "",
      "Provider quota",
      "Session",
      "47% left",
      "⏱ reset in 9m",
      "",
      "Weekly",
      "28% left",
      "⏱ reset in 1d 0h 0m",
    ].join("\n"),
  );
  assert.equal(p.personalDaily?.remaining, 80);
  assert.equal(p.personalWeekly?.remaining, 90);
  assert.equal(p.session?.remaining, 47);
  assert.equal(p.providerWeekly?.remaining, 28);
  // reset line → raw countdown label + compact remaining (15h → 15H, 9m → 9M).
  assert.equal(p.personalDaily?.resetLabel, "⏱ 15h 0m");
  assert.equal(p.personalDaily?.remainingLabel, "15H");
  assert.equal(p.personalWeekly?.remainingLabel, "7D");
  assert.equal(p.session?.remainingLabel, "9M");
});

test("om-usage: section switching — Weekly means personal or provider by section", () => {
  const p = parseOmniUsageText(
    ["Provider quota", "Weekly", "10% left", "Personal quota", "Weekly", "20% left"].join("\n"),
  );
  assert.equal(p.providerWeekly?.remaining, 10);
  assert.equal(p.personalWeekly?.remaining, 20);
  assert.equal(p.session, undefined);
  assert.equal(p.personalDaily, undefined);
});

test("om-usage: out-of-range percentages are skipped", () => {
  const p = parseOmniUsageText(["Personal quota", "Daily", "150% left", "Weekly", "-5% left"].join("\n"));
  assert.deepEqual(p, {});
});

test("om-usage: non-report text parses empty (disabled key, no cached data)", () => {
  assert.deepEqual(parseOmniUsageText("Usage command is disabled for this API key."), {});
  assert.deepEqual(parseOmniUsageText("Provider quota\nNo cached usage data available."), {});
  assert.deepEqual(parseOmniUsageText(""), {});
});

// ── commandCodeWindowToUsageWindow — /alpha/billing/credits JSON shape ───────

test("commandcode credits: USD window maps used/cap → remaining%, resetAt ms → labels", () => {
  // Live response shape (resetAt is epoch milliseconds):
  const w = commandCodeWindowToUsageWindow({ used: 2.5, cap: 10, exceeded: false, resetAt: Date.now() + 3_600_000 });
  assert.ok(w);
  assert.equal(w.percent, 25);
  assert.equal(w.remaining, 75);
  assert.match(w.remainingLabel ?? "", /^\d+[HM]$/, "future reset → compact remaining");
  assert.ok(w.resetLabel, "reset clock label present");
});

test("commandcode credits: full response drives fiveHour + weekly windows", () => {
  const w5 = commandCodeWindowToUsageWindow({ used: 0.25, cap: 5, resetAt: Date.now() + 7_200_000 });
  const wk = commandCodeWindowToUsageWindow({ used: 3.75, cap: 50, resetAt: Date.now() + 86_400_000 });
  assert.equal(w5?.remaining, 95);
  // 3.75/50 = 7.5% used → Math.round → 8 → remaining 92.
  assert.equal(wk?.remaining, 92);
});

test("commandcode credits: over-cap clamps to 0 remaining, bad windows → undefined", () => {
  const over = commandCodeWindowToUsageWindow({ used: 12, cap: 10 });
  assert.equal(over?.percent, 100);
  assert.equal(over?.remaining, 0);
  assert.equal(commandCodeWindowToUsageWindow(undefined), undefined);
  assert.equal(commandCodeWindowToUsageWindow({ used: 1, cap: 0 }), undefined);
  assert.equal(commandCodeWindowToUsageWindow({ used: 1, cap: undefined as unknown as number }), undefined);
  // past resetAt (or missing) → no remaining label, window still valid
  const past = commandCodeWindowToUsageWindow({ used: 1, cap: 10 });
  assert.equal(past?.remaining, 90);
});

// ── parseEnvText — .env.local stdlib-style parser ────────────────────────────

test("env: export prefix, quotes, comments, plain values", () => {
  const parsed = parseEnvText(
    [
      "# leading comment",
      "",
      "export ROUTER_API_KEY=rk_123",
      'QUOTED="hello world"',
      "SINGLE='v'",
      "PLAIN=1",
      "A_1=b c",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    ROUTER_API_KEY: "rk_123",
    QUOTED: "hello world",
    SINGLE: "v",
    PLAIN: "1",
    A_1: "b c",
  });
});

test("env: CRLF files, non-assignment lines, `#` stays part of the value", () => {
  const parsed = parseEnvText("export A=1\r\nB=2\r\nnot an assignment\r\nKEY=value # note");
  assert.deepEqual(parsed, { A: "1", B: "2", KEY: "value # note" });
});

// ── routerUpstreamPrefix — router model id → upstream provider slug ─────────

test("router: alias normalization maps to canonical upstream slugs", () => {
  assert.equal(routerUpstreamPrefix({ id: "command-code/deepseek/deepseek-v4-flash" }), "command-code");
  assert.equal(routerUpstreamPrefix({ id: "cmd/deepseek/deepseek-v4-flash" }), "command-code");
  assert.equal(routerUpstreamPrefix({ id: "oc/gpt-5" }), "opencode-go");
  assert.equal(routerUpstreamPrefix({ id: "ds/v4" }), "deepseek");
  // glm-cn is OmniRoute's connection slug (not the Pi provider id zai-coding-cn).
  assert.equal(routerUpstreamPrefix({ id: "glm-cn/glm-5.2" }), "glm-cn");
  assert.equal(routerUpstreamPrefix({ id: "glmcn/glm-5.2" }), "glm-cn");
  assert.equal(routerUpstreamPrefix({ id: "zai-coding/glm-5.2" }), "zai-coding");
});

test("router: generic aliases carry no provider info → undefined", () => {
  assert.equal(routerUpstreamPrefix({ id: "auto/best" }), undefined);
  assert.equal(routerUpstreamPrefix({ id: "openrouter/gpt-5" }), undefined);
  assert.equal(routerUpstreamPrefix({ id: "nvidia/gpt-5" }), undefined);
  assert.equal(routerUpstreamPrefix({ id: "" }), undefined);
});

// ── tokPerSecLabel — usage.reasoning ⊂ usage.output, never summed ────────────

test("tok/s: think/answer split math (answer = output − reasoning)", () => {
  assert.equal(tokPerSecLabel(3200, 2500, 70_000), "46 tok/s (36 think + 10 answer)");
  assert.equal(tokPerSecLabel(200, 0, 10_000), "20 tok/s");
  assert.equal(tokPerSecLabel(1000, 1000, 10_000), "100 tok/s (100 think + 0 answer)");
  assert.equal(tokPerSecLabel(300, -1, 10_000), "30 tok/s");
});
