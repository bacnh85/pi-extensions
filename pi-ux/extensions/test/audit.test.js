import assert from "node:assert/strict";
import test from "node:test";

import {
  channelLuminance,
  relativeLuminance,
  contrastRatio,
  parseHex,
  parseOklch,
  parseColor,
  sRGBtoY,
  apcaContrastLc,
  apcaThreshold,
  extractTokens,
  scanOffSystem,
  scanStates,
  scanSlopTells,
  audit,
} from "../../hooks/ux-audit.js";

// --- WCAG math ------------------------------------------------------------

test("channelLuminance linearises sRGB (0 and 255 extremes)", () => {
  assert.equal(channelLuminance(0), 0);
  assert.ok(channelLuminance(255) > 0.99 && channelLuminance(255) < 1.01);
});

test("relativeLuminance handles 3-digit and 6-digit hex", () => {
  assert.equal(relativeLuminance("#000"), relativeLuminance("#000000"));
  assert.equal(relativeLuminance("#fff"), relativeLuminance("#FFFFFF"));
});

test("relativeLuminance strips alpha from 4/8-digit hex (#RRGGBBAA / #RGBA)", () => {
  assert.equal(relativeLuminance("#ff0000"), relativeLuminance("#ff0000ff"));
  assert.equal(relativeLuminance("#f00"), relativeLuminance("#f00f"));
  assert.equal(relativeLuminance("#0066ff"), relativeLuminance("#0066ff80"));
});

test("relativeLuminance returns null for garbage", () => {
  assert.equal(relativeLuminance("red"), null);
  assert.equal(relativeLuminance("#12345"), null);
});

test("contrastRatio: white/black = 21, identical = 1", () => {
  assert.equal(contrastRatio("#000", "#000"), 1);
  // ponytail: 21:1 is the WCAG maximum; allow float rounding.
  const max = contrastRatio("#fff", "#000");
  assert.ok(max >= 20 && max <= 21, `expected ~21, got ${max}`);
});

test("contrastRatio returns null when a colour is invalid", () => {
  assert.equal(contrastRatio("#000", "nope"), null);
});

// --- tokens ---------------------------------------------------------------

test("extractTokens indexes :root declarations by value", () => {
  const css = `:root { --accent: #0066ff; --space-2: 8px; }`;
  const tokens = extractTokens(css);
  assert.equal(tokens.get("#0066ff"), "--accent");
  assert.equal(tokens.get("8px"), "--space-2");
});

test("extractTokens indexes :root.dark and grouped :root variants", () => {
  const css = `:root { --accent: #0066ff; } :root.dark { --accent: #82b1ff; } :root[data-theme=\"dim\"] { --bg: #111; }`;
  const tokens = extractTokens(css);
  assert.equal(tokens.get("#0066ff"), "--accent");
  assert.equal(tokens.get("#82b1ff"), "--accent", "dark-mode override must be a token");
  assert.equal(tokens.get("#111"), "--bg", "attribute-selector variant must be a token");
});

test("scanOffSystem flags hardcoded hex outside :root", () => {
  const css = `:root { --accent: #0066ff; } .card { color: #ff0000; }`;
  const tokens = extractTokens(css);
  const off = scanOffSystem(css, tokens);
  assert.deepEqual(off.hardcodedHex, ["#ff0000"]);
  assert.deepEqual(off.adhocShadow, []);
});

test("scanOffSystem does NOT flag hex in :root.dark or grouped :root blocks", () => {
  const css = `:root { --accent: #0066ff; } :root.dark { --accent: #82b1ff; }`;
  const tokens = extractTokens(css);
  const off = scanOffSystem(css, tokens);
  assert.deepEqual(off.hardcodedHex, [], "dark-mode token values must not be flagged");
});

test("scanOffSystem does NOT flag hex values that match a token", () => {
  const css = `:root { --accent: #0066ff; } .card { color: #0066ff; }`;
  const tokens = extractTokens(css);
  const off = scanOffSystem(css, tokens);
  assert.deepEqual(off.hardcodedHex, []);
});

test("scanOffSystem flags box-shadow not built from var()", () => {
  const css = `.card { box-shadow: 0 4px 12px rgba(0,0,0,0.1); }`;
  const tokens = extractTokens(css);
  const off = scanOffSystem(css, tokens);
  assert.ok(off.adhocShadow.length === 1);
  assert.match(off.adhocShadow[0], /rgba/);
});

test("scanOffSystem does NOT flag box-shadow using var()", () => {
  const css = `:root { --elev-md: 0 4px 12px rgba(0,0,0,0.1); } .card { box-shadow: var(--elev-md); }`;
  const tokens = extractTokens(css);
  const off = scanOffSystem(css, tokens);
  assert.deepEqual(off.adhocShadow, []);
});

// --- states ---------------------------------------------------------------

test("scanStates flags missing focus-visible and disabled", () => {
  const css = `button { color: var(--accent); } a { text-decoration: none; }`;
  const states = scanStates(css);
  assert.ok(states.missingFocusVisible.length === 1);
  assert.ok(states.missingDisabled.length === 1);
});

test("scanStates passes when focus-visible and disabled exist", () => {
  const css = `button { color: var(--accent); } button:focus-visible { outline: 2px solid var(--accent); } button:disabled { opacity: 0.5; }`;
  const states = scanStates(css);
  assert.deepEqual(states.missingFocusVisible, []);
  assert.deepEqual(states.missingDisabled, []);
});

test("scanStates returns empty when no interactive selectors present", () => {
  const css = `.card { padding: 8px; }`;
  const states = scanStates(css);
  assert.deepEqual(states.missingFocusVisible, []);
  assert.deepEqual(states.missingDisabled, []);
});

// --- aggregate gate -------------------------------------------------------

test("audit.pass is true for a clean, token-compliant stylesheet", () => {
  const css = `
    :root { --accent: #0066ff; --text: #111; --bg: #fff; --elev: 0 2px 8px rgba(0,0,0,0.08); }
    .card { color: var(--text); background: var(--bg); box-shadow: var(--elev); padding: 8px; }
    button { color: var(--accent); }
    button:focus-visible { outline: 2px solid var(--accent); }
    button:disabled { opacity: 0.5; }
  `;
  const result = audit({ css, pairs: [{ fg: "#111", bg: "#fff", label: "body", min: 4.5 }] });
  assert.equal(result.pass, true);
  assert.equal(result.gates.contrast.pass, true);
  assert.equal(result.gates.tokens.pass, true);
  assert.equal(result.gates.states.pass, true);
});

test("audit.pass is false when contrast fails", () => {
  // light grey on white — fails AA
  const result = audit({ css: "", pairs: [{ fg: "#bbb", bg: "#fff", min: 4.5 }] });
  assert.equal(result.pass, false);
  assert.equal(result.gates.contrast.pass, false);
  assert.ok(result.gates.contrast.results[0].ratio < 4.5);
});

test("audit.pass is false when hardcoded hex present", () => {
  const css = `:root { --accent: #0066ff; } .card { color: #ff0000; }`;
  const result = audit({ css, pairs: [] });
  assert.equal(result.pass, false);
  assert.equal(result.gates.tokens.pass, false);
});

test("audit.pass is false when states missing", () => {
  const css = `button { color: red; }`;
  const result = audit({ css, pairs: [] });
  assert.equal(result.pass, false);
  assert.equal(result.gates.states.pass, false);
});

test("audit treats invalid colour as a failed contrast pair (ratio null, pass false)", () => {
  const result = audit({ css: "", pairs: [{ fg: "not-a-color", bg: "#fff", label: "bad" }] });
  assert.equal(result.pass, false);
  assert.equal(result.gates.contrast.results[0].ratio, null);
  assert.equal(result.gates.contrast.results[0].pass, false);
});

test("audit tolerates { pairs: null } (behaves like an empty list, no throw)", () => {
  const result = audit({ css: "", pairs: null });
  assert.equal(result.gates.contrast.results.length, 0);
  assert.equal(result.gates.contrast.pass, true);
});

test("audit tolerates { css: null } (behaves like empty string, no throw)", () => {
  const result = audit({ css: null, pairs: [] });
  assert.equal(result.gates.tokens.pass, true);
  assert.equal(result.gates.states.pass, true);
});

// --- colour parsing (hex + oklch) -----------------------------------------

test("parseHex accepts 3/4/6/8-digit hex and strips alpha", () => {
  assert.deepEqual(parseHex("#fff"), [255, 255, 255]);
  assert.deepEqual(parseHex("#000000"), [0, 0, 0]);
  assert.deepEqual(parseHex("#0066ff80"), [0, 102, 255]); // 8-digit drops alpha
  assert.deepEqual(parseHex("#f00f"), [255, 0, 0]);       // 4-digit drops alpha
  assert.equal(parseHex("garbage"), null);
});

test("parseOklch converts to sRGB (white and black extremes)", () => {
  const white = parseOklch("oklch(100% 0 0)");
  assert.ok(Math.abs(white[0] - 255) < 2, `white R ~255, got ${white[0]}`);
  const black = parseOklch("oklch(0% 0 0)");
  assert.deepEqual(black, [0, 0, 0]);
});

test("parseOklch returns null on garbage", () => {
  assert.equal(parseOklch("not-a-color"), null);
  assert.equal(parseOklch("oklch(x y z)"), null);
});

// REVIEW FIX 1 (HIGH): percentage lightness must divide by 100, not 1.
// oklch(50% ...) is mid-grey, NOT white.
test("parseOklch percentage L does not collapse to white (regression)", () => {
  const mid = parseOklch("oklch(50% 0 0)");
  assert.ok(Math.abs(mid[0] - 99) < 15, `mid-grey ~99, got ${mid[0]}`);
  assert.ok(mid[0] < 200, "must not be near-white");
});

test("parseOklch saturates correctly (blue hue)", () => {
  const blue = parseOklch("oklch(60% 0.18 250)");
  assert.ok(blue[2] > blue[0], "B must dominate R");
  assert.ok(blue[2] > blue[1], "B must dominate G");
});

// REVIEW FIX 1b (latent): linear sRGB must be gamma-encoded to sRGB before
// *255, or APCA double-linearizes oklch values (contrast becomes wrong).
test("parseOklch gamma-encodes (APCA contrast on oklch matches hex equivalent)", () => {
  // oklch(~21% 0 0) ≈ #333 grey. Cross-check APCA treats them alike.
  const hexLc = apcaContrastLc("#333333", "#ffffff");
  const okLc = apcaContrastLc("oklch(22.6% 0 0)", "oklch(100% 0 0)");
  assert.ok(Math.abs(hexLc - okLc) < 8, `hex ${hexLc} vs oklch ${okLc} must agree`);
});

test("parseColor routes hex and oklch to the right parser", () => {
  assert.deepEqual(parseColor("#111111"), [17, 17, 17]);
  assert.deepEqual(parseColor("oklch(100% 0 0)")[0], 255);
  assert.equal(parseColor("nope"), null);
});

// --- APCA contrast (primary gate) -----------------------------------------

test("apcaContrastLc: black on white ≈ Lc 105 (near the known max)", () => {
  const lc = apcaContrastLc("#000000", "#ffffff");
  assert.ok(lc >= 100 && lc <= 107, `expected ~105, got ${lc}`);
  assert.ok(lc > 0, "dark text on light bg must be positive (BoW polarity)");
});

test("apcaContrastLc: white on black is negative (WoB polarity)", () => {
  const lc = apcaContrastLc("#ffffff", "#000000");
  assert.ok(lc < 0, "light text on dark bg must be negative");
  assert.ok(lc <= -100, `expected ~-106, got ${lc}`);
});

test("apcaContrastLc: dark-theme thin-text slop FAILS where WCAG passes", () => {
  // #aaa light grey on #1e1e1e dark — the classic text-only-model dark slop.
  // APCA catches this; WCAG ratio would pass it.
  const lc = apcaContrastLc("#aaaaaa", "#1e1e1e");
  assert.ok(lc < 0, "must be negative (WoB)");
  assert.ok(Math.abs(lc) < 75, `Lc ${lc} should fail body threshold (75), proving APCA > WCAG`);
});

test("apcaContrastLc returns null for unparseable colour", () => {
  assert.equal(apcaContrastLc("not-a-color", "#fff"), null);
});

test("apcaThreshold scales by weight and size", () => {
  assert.equal(apcaThreshold(400, 16), 75, "body text = strictest");
  assert.equal(apcaThreshold(700, 16), 60, "bold body stays at 60 (not 45)");
  assert.equal(apcaThreshold(700, 14), 60, "bold small body = 60");
  assert.equal(apcaThreshold(700, 18), 45, "bold + large relaxes to 45");
  assert.equal(apcaThreshold(700, 24), 45, "bold + very large = 45");
  assert.equal(apcaThreshold(400, 24), 45, "large non-bold relaxes to 45");
  assert.equal(apcaThreshold(400, 18), 60, "regular ≥18px = 60");
  assert.equal(apcaThreshold(500, 18), 60, "medium weight + 18px = 60");
});

// --- audit with APCA + WCAG sidecar ---------------------------------------

test("audit reports both APCA Lc and WCAG ratio in contrast results", () => {
  const result = audit({ css: "", pairs: [{ fg: "#111111", bg: "#ffffff", label: "body", weight: 400, size: 16 }] });
  const r = result.gates.contrast.results[0];
  assert.ok(r.apca !== null && r.apca > 100, "APCA Lc present and high for black-on-white");
  assert.ok(r.ratio > 15, "WCAG ratio present (~21)");
  assert.equal(r.pass, true);
  assert.equal(r.apcaMin, 75);
});

test("audit fails when APCA Lc is below threshold even if WCAG ratio passes", () => {
  // #aaa on dark bg: APCA Lc ~54 (fails 75), WCAG ratio ~7.8 (passes 4.5)
  const result = audit({ css: "", pairs: [{ fg: "#aaaaaa", bg: "#1e1e1e", label: "dark-body", min: 4.5, weight: 400, size: 16 }] });
  assert.equal(result.gates.contrast.pass, false, "must fail on APCA");
  assert.equal(result.pass, false);
  const r = result.gates.contrast.results[0];
  assert.ok(r.ratio >= 4.5, "WCAG sidecar still passes for reporting");
});

test("audit still works with legacy pairs (no weight/size) — APCA default 75", () => {
  const result = audit({ css: "", pairs: [{ fg: "#111111", bg: "#ffffff", min: 4.5 }] });
  assert.equal(result.gates.contrast.pass, true);
  assert.equal(result.gates.contrast.results[0].apcaMin, 75);
});

// --- slop tells (Phase 3) --------------------------------------------------

test("scanSlopTells flags glassmorphism (backdrop-filter)", () => {
  const { tells } = scanSlopTells(".card { backdrop-filter: blur(10px); } .card { color: red; }");
  assert.equal(tells.length, 1);
  assert.match(tells[0], /glassmorphism/);
});

test("scanSlopTells flags the shadcn default-card reflex", () => {
  const css = ".card { border-radius: rounded-2xl; box-shadow: shadow-lg; padding: p-6; }";
  // ponytail: the heuristic checks class-name co-occurrence, not CSS props
  const css2 = '<div class="rounded-2xl shadow-lg p-6">';
  const { tells } = scanSlopTells(css2);
  assert.equal(tells.length, 1);
  assert.match(tells[0], /default card/);
});

test("scanSlopTells flags 1px gray card border (tailwind default)", () => {
  const { tells } = scanSlopTells(".card { border-zinc-200: 1px; }");
  assert.equal(tells.length, 1);
  assert.match(tells[0], /1px gray card border/);
});

test("scanSlopTells flags 1px gray card border (literal hex)", () => {
  const { tells } = scanSlopTells(".card { border: 1px solid #e5e7eb; }");
  assert.equal(tells.length, 1);
  assert.match(tells[0], /1px gray card border/);
});

test("scanSlopTells does NOT flag clean token-based elevation", () => {
  const css = `
    :root { --elev-md: 0 2px 8px rgba(0,0,0,0.08); }
    .card { box-shadow: var(--elev-md); border-radius: 8px; padding: 16px; }
  `;
  const { tells } = scanSlopTells(css);
  assert.deepEqual(tells, []);
});

test("scanSlopTells does NOT flag legitimate small radial highlight", () => {
  const css = ".badge { background: radial-gradient(circle, #fff 0%, #eee 100%); }";
  const { tells } = scanSlopTells(css);
  assert.deepEqual(tells, [], "small radial without big blur is not an orb");
});

test("audit integrates slop-tell gate: full slop dump fails", () => {
  const slopCss = `
    .hero { backdrop-filter: blur(20px); }
    .card { @apply rounded-2xl shadow-lg p-6; border-zinc-200; }
  `;
  const result = audit({ css: slopCss, pairs: [] });
  assert.equal(result.gates.slopTells.pass, false);
  assert.ok(result.gates.slopTells.tells.length >= 1);
  assert.equal(result.pass, false);
});

test("audit.clean sheet passes all four gates", () => {
  const css = `
    :root { --accent: #0066ff; --text: #111; --bg: #fff; --elev: 0 2px 8px rgba(0,0,0,0.08); }
    .card { color: var(--text); background: var(--bg); box-shadow: var(--elev); padding: 16px; }
    button { color: var(--accent); }
    button:focus-visible { outline: 2px solid var(--accent); }
    button:disabled { opacity: 0.5; }
  `;
  const result = audit({ css, pairs: [{ fg: "#111", bg: "#fff", label: "body", weight: 400, size: 16 }] });
  assert.equal(result.pass, true);
  assert.equal(result.gates.slopTells.pass, true);
  assert.equal(result.gates.contrast.pass, true);
  assert.equal(result.gates.tokens.pass, true);
  assert.equal(result.gates.states.pass, true);
});

// --- REVIEW FIX regressions (v0.4.2) --------------------------------------
// These pin each reviewer-found bug to a runnable check so they can't return.

// FIX 2 (MEDIUM FP): a normal accent focus shadow (≤12px blur) is NOT neon glow.
test("scanSlopTells does NOT flag a normal accent shadow (≤12px blur)", () => {
  const { tells } = scanSlopTells(".btn { box-shadow: 0 4px 12px rgba(0,102,255,0.35); }");
  assert.deepEqual(tells, [], "small coloured shadow is normal, not glow");
});

// FIX 3 (MEDIUM FN): a large coloured hex shadow IS neon glow (was missed).
test("scanSlopTells flags large coloured hex shadow as neon glow", () => {
  const { tells } = scanSlopTells(".card { box-shadow: 0 0 40px #8b00ff; }");
  assert.equal(tells.length, 1);
  assert.match(tells[0], /neon glow/);
});

test("scanSlopTells flags large coloured rgba glow", () => {
  const { tells } = scanSlopTells(".hero { box-shadow: 0 0 40px 20px rgba(139,0,255,0.6); }");
  assert.equal(tells.length, 1);
  assert.match(tells[0], /neon glow/);
});

test("scanSlopTells still does NOT flag greyscale large shadow", () => {
  const { tells } = scanSlopTells(".card { box-shadow: 0 0 40px rgba(0,0,0,0.4); }");
  assert.deepEqual(tells, [], "greyscale shadow is elevation, not glow");
});

// FIX 4 (LOW): radial-gradient with nested rgba/hsl stops is fully captured.
test("scanSlopTells flags gradient orb with nested rgba + filter blur", () => {
  const css = ".orb { background: radial-gradient(circle, rgba(138,43,226,0.8) 0%, #4b0082 100%); filter: blur(80px); }";
  const { tells } = scanSlopTells(css);
  assert.equal(tells.length, 1);
  assert.match(tells[0], /gradient orb/);
});

test("scanSlopTells does NOT flag a small warm radial highlight", () => {
  const css = ".badge { background: radial-gradient(circle, #fff 0%, #eee 100%); }";
  const { tells } = scanSlopTells(css);
  assert.deepEqual(tells, [], "non-violet small radial is not an orb");
});

// FIX 6 (LOW): alpha hex (#RRGGBBAA / #RGBA) is flagged by the token gate.
test("scanOffSystem flags 8-digit alpha hex outside :root", () => {
  const off = scanOffSystem(".card { color: #ff000080; }", new Map());
  assert.deepEqual(off.hardcodedHex, ["#ff000080"]);
});

test("scanOffSystem flags 4-digit alpha hex outside :root", () => {
  const off = scanOffSystem(".card { color: #f00f; }", new Map());
  assert.deepEqual(off.hardcodedHex, ["#f00f"]);
});

test("scanOffSystem does NOT partial-match an 8-digit hex as a 6-digit value", () => {
  // Regression guard: must report the full 8-digit value, not '#ff0000'.
  const off = scanOffSystem(".card { color: #ff000080; }", new Map());
  assert.ok(!off.hardcodedHex.includes("#ff0000"), "must not partial-match");
  assert.ok(off.hardcodedHex.includes("#ff000080"));
});
