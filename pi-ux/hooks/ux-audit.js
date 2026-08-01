// pi-ux — deterministic slop-audit engine (no model, no deps).
//
// Four gates, all computable:
//   1. Contrast  — APCA Lc (primary, perceptual) + WCAG 2.x ratio (sidecar).
//   2. Tokens    — off-system values (raw hex, magic px, ad-hoc shadows).
//   3. States    — interactive elements missing focus-visible / disabled.
//   4. SlopTells — named AI signatures (glassmorphism, orbs, glow, default-card).
//
// Ponytail: all gates are mechanical linting, not judgement. APCA math is
// ~25 lines; WCAG is ~10; token scan is regex; state scan is substring; tell
// scan is co-occurrence heuristics. No wcag-contrast lib, no css parser, no AST.

// --- colour parsing -------------------------------------------------------
// Accepts hex (3/4/6/8-digit) and oklch(L C H) / oklch(L C H / a). Returns
// [r,g,b] 0-255, or null. oklch support matters because DESIGN.md (Google's
// open standard) allows oklch() values.

function parseHex(hex) {
  const m = /^#?([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})$/i.exec(String(hex).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 8) h = h.slice(0, 6); // drop alpha
  if (h.length === 4) h = h.slice(0, 3);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ponytail: standard oklch->linear-sRGB->sRGB. ~20 lines, no dep. Handles the
// cases DESIGN.md allows; guards NaN/overflow.
function parseOklch(str) {
  const m = /^oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+([0-9.]+)(?:deg)?\s*(?:\/\s*([0-9.]+))?%?\s*\)$/i.exec(String(str).trim());
  if (!m) return null;
  const L = Math.min(Math.max(parseFloat(m[1]) / (String(m[1]).endsWith('%') ? 100 : 1), 0), 1);
  const C = parseFloat(m[2]);
  const Hdeg = parseFloat(m[3]);
  if ([L, C, Hdeg].some(Number.isNaN)) return null;
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  // OKLab -> linear sRGB
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
  // linear -> sRGB gamma encoding, then to 0-255. APCA's sRGBtoY expects
  // gamma-encoded sRGB (same as hex produces); without this, oklch values
  // double-linearize and contrast is wrong.
  const enc = (c) => {
    c = Math.min(Math.max(c, 0), 1);
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };
  const to255 = (c) => Math.round(enc(c) * 255);
  return [to255(r), to255(g), to255(bl)];
}

function parseColor(input) {
  const s = String(input).trim();
  if (s.startsWith('#') || /^[0-9a-f]{3,8}$/i.test(s)) return parseHex(s);
  if (s.toLowerCase().startsWith('oklch')) return parseOklch(s);
  // ponytail: named/hsl/rgb not supported — DESIGN.md tokens use hex/oklch.
  // Tokens with other formats are just not contrast-checkable here; the gate
  // still runs on the pairs that ARE parseable.
  return parseHex(s); // falls back to hex parser (returns null on garbage)
}

// --- APCA contrast (primary gate) -----------------------------------------
// Canonical APCA 0.0.98G-4g (W3, constants fixed since Feb 2021). Source:
// Myndex/apca-w3 master src/apca-w3.js (fetched 2024). Returns signed Lc:
// positive = dark text on light bg (BoW); negative = light text on dark (WoB).
// Range ≈ ±106. Polarity matters — text is the FIRST arg, bg the SECOND.

const APCA = {
  mainTRC: 2.4, sRco: 0.2126729, sGco: 0.7151522, sBco: 0.0721750,
  normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  blkThrs: 0.022, blkClmp: 1.414, scaleBoW: 1.14, scaleWoB: 1.14,
  loBoWoffset: 0.027, loWoBoffset: 0.027, deltaYmin: 0.0005, loClip: 0.1,
};

function sRGBtoY(rgb) {
  const [r, g, b] = rgb;
  const exp = (chan) => Math.pow(chan / 255.0, APCA.mainTRC);
  return APCA.sRco * exp(r) + APCA.sGco * exp(g) + APCA.sBco * exp(b);
}

function apcaContrastLc(textColor, bgColor) {
  const txtRgb = parseColor(textColor);
  const bgRgb = parseColor(bgColor);
  if (!txtRgb || !bgRgb) return null;
  let txtY = sRGBtoY(txtRgb);
  let bgY = sRGBtoY(bgRgb);
  if (isNaN(txtY) || isNaN(bgY) || Math.min(txtY, bgY) < 0 || Math.max(txtY, bgY) > 1.1) return 0.0;
  // soft black clamp
  txtY = txtY > APCA.blkThrs ? txtY : txtY + Math.pow(APCA.blkThrs - txtY, APCA.blkClmp);
  bgY = bgY > APCA.blkThrs ? bgY : bgY + Math.pow(APCA.blkThrs - bgY, APCA.blkClmp);
  if (Math.abs(bgY - txtY) < APCA.deltaYmin) return 0.0;
  let SAPC, out;
  if (bgY > txtY) { // BoW: dark text on light
    SAPC = (Math.pow(bgY, APCA.normBG) - Math.pow(txtY, APCA.normTXT)) * APCA.scaleBoW;
    out = SAPC < APCA.loClip ? 0.0 : SAPC - APCA.loBoWoffset;
  } else { // WoB: light text on dark — negative
    SAPC = (Math.pow(bgY, APCA.revBG) - Math.pow(txtY, APCA.revTXT)) * APCA.scaleWoB;
    out = SAPC > -APCA.loClip ? 0.0 : SAPC + APCA.loWoBoffset;
  }
  return out * 100.0;
}

// APCA threshold for a text/bg pair by font weight + size (px).
// Spec guidance: Lc 75 body, 60 for 400@18px+, 45 large/bold, 30 non-text.
function apcaThreshold(weight, size) {
  const w = typeof weight === 'number' ? weight : 400;
  const s = typeof size === 'number' ? size : 16;
  const bold = w >= 700;
  // APCA font-Lc lookup: Lc 45 = ≥24px regular or ≥18px bold; Lc 60 = ≥18px
  // regular or bold body (14–17px); Lc 75 = small body. Bold body text is
  // NOT exempt from readability — it stays at Lc 60 until it's also large.
  if (s >= 24 || (bold && s >= 18)) return 45;
  if (s >= 18 || bold) return 60;
  return 75; // body text — strictest
}

// --- WCAG 2.x contrast (compliance sidecar) -------------------------------
// Kept verbatim from v0.3.0 — some orgs must report the WCAG ratio. APCA is
// the primary gate; WCAG is shown alongside for procurement/legal.

function channelLuminance(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const rgb = parseColor(hex);
  if (!rgb) return null;
  return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2]);
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
// system. :root variants (:root.dark, :root[data-theme], grouped :root, .x)
// are standard dark-mode patterns (shadcn, Tailwind, MUI). \b after :root
// avoids false matches like :rootCause.
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
      const key = value.toLowerCase().replace(/\s+/g, ' ');
      const existing = tokens.get(key);
      tokens.set(key, existing ? `${existing},--${name}` : `--${name}`);
    }
  }
  return tokens;
}

// ponytail: negative lookahead (?![0-9a-f]) instead of \b — \b fails between
// adjacent hex digits so 8-digit alpha hex (#RRGGBBAA) was invisible to this
// gate. Now matches 3/4/6/8-digit hex without partial-matching longer values.
const RAW_HEX_RE = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-f])/gi;
const BOX_SHADOW_RE = /box-shadow\s*:\s*([^;}]+)/gi;

function scanOffSystem(css, tokens) {
  const findings = { hardcodedHex: [], adhocShadow: [] };

  const rootFree = css.replace(/:root\b[^{]*\{[^}]*\}/g, '');
  let hexMatch;
  while ((hexMatch = RAW_HEX_RE.exec(rootFree)) !== null) {
    const hex = hexMatch[0];
    const key = hex.toLowerCase();
    if (!tokens.has(key)) findings.hardcodedHex.push(hex);
  }

  let shadowMatch;
  while ((shadowMatch = BOX_SHADOW_RE.exec(rootFree)) !== null) {
    const val = shadowMatch[1];
    if (!/var\(--/.test(val)) findings.adhocShadow.push(val.trim());
  }

  return findings;
}

// --- state coverage -------------------------------------------------------

// ponytail: presence check, not a CSS parser. Stateful /g regexes with
// .test() flake across calls, so use plain includes().
function scanStates(css) {
  const findings = { missingFocusVisible: [], missingDisabled: [] };

  const hasInteractive =
    /\b(?:button|a|input|select|textarea)\b/i.test(css) || /\[role\s*=\s*"?button"?\]/i.test(css);
  if (!hasInteractive) return findings;

  if (!css.includes(':focus-visible')) findings.missingFocusVisible.push('no :focus-visible rule for interactive elements');
  if (!css.includes(':disabled')) findings.missingDisabled.push('no :disabled rule for interactive elements');

  return findings;
}

// --- slop tells (named AI signatures) -------------------------------------
// Co-occurrence heuristics, not single-keyword flags, to avoid false positives
// on legitimate token-based elevation. Each tell is documented with the slop it
// catches and the conservative pattern that must all match.

function scanSlopTells(css) {
  const tells = [];
  const lower = css.toLowerCase();

  // 1. Glassmorphism — backdrop-filter anywhere is the tell.
  if (lower.includes('backdrop-filter')) {
    tells.push('glassmorphism (backdrop-filter) — faux depth implying capability the feature lacks');
  }

  // 2. Gradient orbs — radial-gradient with a violet/purple/indigo hue +
  //    large blur. The orb signature is a big diffuse coloured blob: check
  //    for a blue-dominant saturated hex (B > R+20 AND B > G+20) and a large
  //    blur (filter:blur(NNpx) in the CSS or ≥100px size in the gradient).
  //    ponytail: allow one level of nested parens (rgba/hsl stops) so the
  //    full gradient value is captured, not truncated at the first inner ).
  const hasBigFilterBlur = /blur\(\s*\d{2,}\s*px/i.test(css);
  const radial = /radial-gradient\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi;
  let rm;
  while ((rm = radial.exec(css)) !== null) {
    const v = rm[0];
    const hasVioletHue = [...v.matchAll(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi)].some((hm) => {
      const rgb = parseHex(hm[0]);
      if (!rgb) return false;
      return rgb[2] > rgb[0] + 20 && rgb[2] > rgb[1] + 20; // B-dominant
    });
    const bigBlur = hasBigFilterBlur || /\b\d{3,}px\b/.test(v);
    if (hasVioletHue && bigBlur) {
      tells.push('gradient orb (violet/purple radial-gradient with large blur) — the #1 AI-slop signature');
      break;
    }
  }

  // 3. Neon glow — coloured box-shadow with large blur (≥20px). Checks BOTH
  //    rgba() and hex colours. A normal accent shadow (≤12px blur) is NOT a
  //    glow; a large coloured blur is the v0/Cursor tell.
  const shadowRe = /box-shadow\s*:\s*([^;}]+)/gi;
  let sm;
  while ((sm = shadowRe.exec(css)) !== null) {
    const v = sm[1];
    const pxVals = [...v.matchAll(/(\d+(?:\.\d+)?)px/gi)].map((mm) => parseFloat(mm[1]));
    const maxPx = pxVals.length ? Math.max(...pxVals) : 0;
    if (maxPx < 20) continue; // small blur = normal shadow, not glow

    const colours = [];
    for (const cm of v.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+))?\s*\)/gi)) {
      colours.push([+cm[1], +cm[2], +cm[3], cm[4] !== undefined ? parseFloat(cm[4]) : 1]);
    }
    for (const hm of v.matchAll(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
      const rgb = parseHex(hm[0]);
      if (rgb) colours.push([rgb[0], rgb[1], rgb[2], 1]);
    }
    let foundGlow = false;
    for (const [r, g, b, a] of colours) {
      const greyish = Math.abs(r - g) < 15 && Math.abs(g - b) < 15;
      if (!greyish && a >= 0.3) { foundGlow = true; break; }
    }
    if (foundGlow) {
      tells.push('neon glow (coloured large-blur box-shadow) — v0/Cursor signature');
      break;
    }
  }

  // 4. The default card — untouched shadcn reflex. Require rounded-2xl/3xl AND
  //    shadow-lg/xl AND p-6/p-8 to co-occur (the actual slop reflex).
  if (/(rounded-(2xl|3xl))/.test(lower) && /(shadow-(lg|xl))/.test(lower) && /\bp-(6|8)\b/.test(lower)) {
    tells.push('default card (rounded-2xl + shadow-lg + p-6 reflex) — separate with whitespace → bg shift → elevation first');
  }

  // 5. 1px gray card border — the most reliable single AI tell. Tailwind
  //    border-zinc/gray defaults OR a literal 1px solid near-gray hex.
  const tailwindGray = /\bborder-(zinc|gray|slate|neutral)-(?:100|200)\b/.test(lower);
  const litGrayBorder = /border[^;}]*:\s*1px\s+solid\s+(#(?:e5e7eb|e4e4e7|d4d4d8|f1f5f9|e2e8f0))\b/i.test(css);
  if (tailwindGray || litGrayBorder) {
    tells.push('1px gray card border (border-zinc/gray default or near-gray 1px solid) — the most reliable AI tell');
  }

  return { tells };
}

// --- aggregate gate -------------------------------------------------------

function audit({ css = '', pairs = [] }) {
  const safeCss = typeof css === 'string' ? css : '';
  const safePairs = Array.isArray(pairs) ? pairs : [];
  const tokens = extractTokens(safeCss);
  const off = scanOffSystem(safeCss, tokens);
  const states = scanStates(safeCss);
  const tells = scanSlopTells(safeCss);

  const contrastResults = safePairs.map((p) => {
    const lc = apcaContrastLc(p.fg, p.bg);
    const ratio = contrastRatio(p.fg, p.bg);
    const apcaMin = apcaThreshold(p.weight, p.size);
    // pass follows APCA (primary). A pair passes if APCA is present and meets
    // its threshold; if APCA is null (unparseable colour), fail on WCAG.
    let pass;
    if (lc === null) {
      pass = ratio === null ? false : ratio >= (p.min ?? 4.5);
    } else {
      pass = Math.abs(lc) >= apcaMin;
    }
    return {
      ...p,
      apca: lc === null ? null : Math.round(lc * 100) / 100,
      apcaMin,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      pass,
    };
  });

  const contrastPass = contrastResults.every((r) => r.pass);

  return {
    gates: {
      contrast: { pass: contrastPass, results: contrastResults },
      tokens: { pass: off.hardcodedHex.length === 0 && off.adhocShadow.length === 0, ...off },
      states: { pass: states.missingFocusVisible.length === 0 && states.missingDisabled.length === 0, ...states },
      slopTells: { pass: tells.tells.length === 0, ...tells },
    },
    pass: contrastPass
      && off.hardcodedHex.length === 0 && off.adhocShadow.length === 0
      && states.missingFocusVisible.length === 0 && states.missingDisabled.length === 0
      && tells.tells.length === 0,
  };
}

module.exports = {
  parseHex,
  parseOklch,
  parseColor,
  sRGBtoY,
  apcaContrastLc,
  apcaThreshold,
  channelLuminance,
  relativeLuminance,
  contrastRatio,
  extractTokens,
  scanOffSystem,
  scanStates,
  scanSlopTells,
  audit,
};
