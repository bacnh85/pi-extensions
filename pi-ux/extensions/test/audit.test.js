import assert from "node:assert/strict";
import test from "node:test";

import {
  channelLuminance,
  relativeLuminance,
  contrastRatio,
  extractTokens,
  scanOffSystem,
  scanStates,
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
