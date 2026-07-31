// pi-ux — deterministic slop-audit engine (no model, no deps).
//
// Three gates, all computable:
//   1. Contrast  — WCAG 2.x relative-luminance ratio for colour pairs.
//   2. Tokens    — off-system values (raw hex, magic px, ad-hoc shadows).
//   3. States    — interactive elements missing focus-visible / disabled.
//
// Ponytail: WCAG math is ~10 lines; token scan is regex; state scan is a
// selector-set check. No wcag-contrast lib, no css parser, no AST. This is
// mechanical linting, not judgement — that is the whole point of the gate.

// --- WCAG contrast --------------------------------------------------------

function channelLuminance(c) {
  // sRGB channel (0-255) -> linear luminance component
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  // Accept 3/4/6/8-digit hex; strip alpha channel from 4/8-digit forms.
  const m = /^#?([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})$/i.exec(String(hex).trim());
  if (!m) return null;
  let h = m[1];
  // 4/8-digit: drop the trailing alpha channel (last 1/2 digits).
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length === 4) h = h.slice(0, 3);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  if (l1 === null || l2 === null) return null;
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

// --- token coverage -------------------------------------------------------

// ponytail: a real CSS parser is overkill. Extract token *names* and *values*
// from :root { --token: value; } so we can tell generated code apart from the
// system.
// ponytail: :root variants (:root.dark, :root[data-theme], grouped :root, .x)
// are standard dark-mode patterns (shadcn, Tailwind, MUI). \b after :root avoids
// false matches like :rootCause. Matches any combinator/selector up to '{'.
function extractTokens(css) {
  const tokens = new Map(); // value -> name(s)
  const rootBlock = /:root\b[^{]*\{([^}]*)\}/g;
  let rootMatch;
  while ((rootMatch = rootBlock.exec(css)) !== null) {
    const decls = rootMatch[1];
    const declRe = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
    let decl;
    while ((decl = declRe.exec(decls)) !== null) {
      const name = decl[1].trim();
      const value = decl[2].trim();
      // index by normalised value so we can match usage in generated css
      const key = value.toLowerCase().replace(/\s+/g, ' ');
      const existing = tokens.get(key);
      tokens.set(key, existing ? `${existing},--${name}` : `--${name}`);
    }
  }
  return tokens;
}

// Hardcoded hex colours not referencing a token.
const RAW_HEX_RE = /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi;

// box-shadow declarations (we only flag these if they DON'T reference a var)
const BOX_SHADOW_RE = /box-shadow\s*:\s*([^;}]+)/gi;

function scanOffSystem(css, tokens) {
  const findings = { hardcodedHex: [], adhocShadow: [] };

  // 1. hardcoded hex outside :root token defs (and :root.dark / grouped variants)
  const rootFree = css.replace(/:root\b[^{]*\{[^}]*\}/g, '');
  let hexMatch;
  while ((hexMatch = RAW_HEX_RE.exec(rootFree)) !== null) {
    const hex = hexMatch[0];
    const key = hex.toLowerCase();
    if (!tokens.has(key)) findings.hardcodedHex.push(hex);
  }

  // 2. box-shadow not built from tokens
  let shadowMatch;
  while ((shadowMatch = BOX_SHADOW_RE.exec(rootFree)) !== null) {
    const val = shadowMatch[1];
    if (!/var\(--/.test(val)) findings.adhocShadow.push(val.trim());
  }

  return findings;
}

// --- state coverage -------------------------------------------------------

// ponytail: presence check, not a CSS parser. Substring tests are enough to
// catch the common slop (missing :focus-visible / :disabled). Stateful /g
// regexes with .test() flake across calls, so use plain includes().
function scanStates(css) {
  const findings = { missingFocusVisible: [], missingDisabled: [] };

  const hasInteractive =
    /\b(?:button|a|input|select|textarea)\b/i.test(css) || /\[role\s*=\s*"?button"?\]/i.test(css);
  if (!hasInteractive) return findings; // no interactive selectors => nothing to flag

  if (!css.includes(':focus-visible')) findings.missingFocusVisible.push('no :focus-visible rule for interactive elements');
  if (!css.includes(':disabled')) findings.missingDisabled.push('no :disabled rule for interactive elements');

  return findings;
}

// --- aggregate gate -------------------------------------------------------

function audit({ css = '', pairs = [] }) {
  // pairs: [{ fg: '#000', bg: '#fff', label: 'body', min: 4.5 }]
  // ponytail: destructure defaults don't cover null — guard explicitly so a
  // malformed { pairs: null } or { css: null } call behaves like the empty
  // value, not a throw.
  const safeCss = typeof css === 'string' ? css : '';
  const safePairs = Array.isArray(pairs) ? pairs : [];
  const tokens = extractTokens(safeCss);
  const off = scanOffSystem(safeCss, tokens);
  const states = scanStates(safeCss);

  const contrastResults = safePairs.map((p) => {
    const ratio = contrastRatio(p.fg, p.bg);
    return {
      ...p,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      pass: ratio === null ? false : ratio >= (p.min ?? 4.5),
    };
  });

  const contrastPass = contrastResults.every((r) => r.pass);

  return {
    gates: {
      contrast: { pass: contrastPass, results: contrastResults },
      tokens: { pass: off.hardcodedHex.length === 0 && off.adhocShadow.length === 0, ...off },
      states: { pass: states.missingFocusVisible.length === 0 && states.missingDisabled.length === 0, ...states },
    },
    pass: contrastPass
      && off.hardcodedHex.length === 0 && off.adhocShadow.length === 0
      && states.missingFocusVisible.length === 0 && states.missingDisabled.length === 0,
  };
}

module.exports = {
  channelLuminance,
  relativeLuminance,
  contrastRatio,
  extractTokens,
  scanOffSystem,
  scanStates,
  audit,
};
