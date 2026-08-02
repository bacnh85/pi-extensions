# Changelog

## 0.4.3

- **Named styles via the design.md library.** `ux-presets` now documents a
  reuse path for named aesthetics (Claymorphism, Brutalism, Bento, Art Deco, …):
  fetch the canonical `DESIGN.md` from the [design.md style library](https://designmd.app/library),
  `npx @google/design.md lint` it, then `ux_audit` — block handoff on fail. No
  style is pre-approved: the stock Claymorphism template ships a button that
  fails `ux_audit` at **Lc −15.67** (lilac `#E6E6FA` on peach `#FDBCB4`),
  corrected to ink-on-peach (Lc 75.72 ✓). Glassmorphism and neumorphism remain
  banned slop tells regardless of library entry.
- Step 2 of "How to use with ux-design" names the library path alongside
  shadcn/Material/Radix as reuse-before-invent options.

## 0.4.2

- **Review fixes** (7 findings, all pinned with regression tests):
  - **FIX (HIGH)** `parseOklch` silently corrupted percentage lightness: the
    regex placed `%?` outside the capture group, so `oklch(L% C H)` (the
    standard CSS form) never divided L by 100, clamping any `0 < L < 100` to
    white. Captured inside the group now. Affects both APCA and WCAG.
  - **FIX (latent)** `parseOklch` returned linear sRGB without gamma encoding;
    APCA's `sRGBtoY` then double-linearized oklch values, making contrast
    wrong. Added the standard linear→sRGB gamma transfer. oklch contrast now
    matches the equivalent hex.
  - **FIX (MEDIUM, FP)** neon-glow heuristic flagged a normal accent shadow
    (≤12px coloured blur) as slop — the `/0\.d/` alpha fallback was too broad.
    Rewritten to require a blur radius ≥ 20px (the actual glow signature).
  - **FIX (MEDIUM, FN)** neon-glow heuristic missed coloured **hex** glow
    shadows (only inspected `rgba?()`). Now parses hex colours in shadows too.
  - **FIX (LOW)** gradient-orb regex truncated at the first inner `)` (nested
    `rgba`/`hsl` stops). Now captures one level of nested parens.
  - **FIX (LOW)** `apcaThreshold` gave bold body text (14–17px) the relaxed
    Lc 45; per APCA guidance bold body text stays at Lc 60 until ≥18px.
  - **FIX (LOW)** alpha hex (`#RRGGBBAA` / `#RGBA`) was invisible to the
    token gate (`\b` failed between adjacent hex digits). Switched to a
    negative-lookahead regex matching 3/4/6/8-digit hex.
- 12 new regression tests (64 → 76).

## 0.4.1

- **Medium-tuned DESIGN.md presets (Web + Mobile).** `ux-presets` Option B is
  now split into **B1 Web** (mouse + keyboard: hover, `:focus-visible`, desktop
  type scale, 65ch measure, responsive container) and **B2 Mobile** (touch-first:
  ≥44pt tap targets, `:active`/pressed with NO `:hover`, safe-area insets,
  16px base to avoid iOS zoom, thumb-zone layout, iOS-HIG/Material notes). Each
  is spec-compliant and lintable from day one.
- **Step 0 unblocks when DESIGN.md is missing.** The resolution order is now:
  (1) use repo-root DESIGN.md if present; (2) reuse an already-wired system
  (shadcn/MUI/Radix/Tailwind); (3) otherwise drop in a medium-tuned preset
  (infer Web vs Mobile from the task; ASK only if genuinely unclear) as the
  implicit system and keep generating; (4) only if no preset fits, generate one
  once with `agy`. The agent no longer stalls in the common no-DESIGN.md case;
  it offers to persist the preset to repo root but does not auto-write.

## 0.4.0

- **DESIGN.md anchor (shift-left).** Step 0 of the ux-design method now points
  at a repo-root **DESIGN.md** (Google Labs open standard) as the single source
  of truth the agent reads before styling. Lint via shell-out:
  `npx @google/design.md lint DESIGN.md` — pi-ux orchestrates the tool, it is
  NOT a runtime dependency (pi-ux stays zero-dep). The `ux-presets` skill ships
  a spec-compliant DESIGN.md starter alongside the existing `:root` CSS block.
- **APCA contrast (primary gate) + WCAG 2.x sidecar.** The `ux_audit` contrast
  gate now reports perceptual APCA Lc as the primary pass/fail (Lc ≥75 body,
  ≥45 large/bold, ≥30 non-text) with the legacy WCAG ratio shown as a
  compliance sidecar for orgs that must report it. APCA catches dark-theme +
  thin-type slop that WCAG 2.x misses — the exact text-only-model failure
  mode. `pairs` gain optional `weight`/`size` to set the APCA threshold.
- **oklch() support.** Colour parsing now accepts `oklch(L C H)` in addition
  to hex (DESIGN.md allows oklch values).
- **Slop-tell gate (4th gate).** New deterministic gate flagging named AI
  signatures: glassmorphism (`backdrop-filter`), gradient orbs, neon glow,
  the untouched shadcn default-card reflex (`rounded-2xl`+`shadow-lg`+`p-6`),
  and 1px gray card borders. Co-occurrence heuristics avoid false positives on
  legitimate token-based elevation.
- **Deterministic-first model routing.** The skill's model-routing table is
  rewritten: text-only models (DeepSeek-v4, GLM-5.2, Kimi K3) now do
  generation + normalisation inside a locked system; `agy`/Gemini/Claude is
  demoted to optional one-time DESIGN.md generation + optional polish — never
  the review gate. Text-only models now lead frontend (Kimi K3 is #1 on the
  Arena.ai Frontend Code Arena, ahead of Claude Fable 5).
- Zero dependencies retained. Plain JS, `node --test` (64 tests).

## 0.3.0

- **`ux_audit` tool (deterministic slop-audit gate).** New LLM-callable tool
  that runs three computable gates — no model needed:
  - **Contrast**: WCAG 2.x relative-luminance ratio for fg/bg colour pairs
    (4.5:1 body, 3:1 large/UI).
  - **Tokens**: flags hardcoded hex outside `:root` token defs and `box-shadow`
    declarations not built from `var(--…)` tokens.
  - **States**: flags interactive selectors (`button`/`a`/`input`/…/`[role=button]`)
    missing `:focus-visible` or `:disabled` rules.
  - Returns a pass/fail per gate + a formatted report. In `strict` mode this is
    the gate that blocks handoff.
- **`ux-presets` skill.** Reference design-system presets for Step 0 (Own the
  system) of the ux-design method — no bundled CSS. Option A: reuse
  shadcn/ui, Material 3, Radix, or Park/Ark UI (YAGNI-first). Option B: a
  compact ~20-line token set (one accent + neutrals, modular type scale, 8px
  spacing grid, 4 named elevation levels) plus audit-ready colour pairs.
- Zero dependencies retained (WCAG math is 10 lines; token scan is regex;
  state scan is substring checks). Plain JS, `node --test`.

## 0.1.0

- Initial release.
- Anti-slop guardrail via `before_agent_start` hook (enforced, not ignorable).
- `/ux` command: `lite | strict | off | status | default <mode>`.
- `skills/ux-design/SKILL.md`: full Constraint-First method + model routing
  (Gemini/Claude via `agy_execute`, DeepSeek-v4 / GLM-5.2 as main Pi models).
- Modes: `lite` (guardrail only), `strict` (guardrail + audit gate, default).
- Config via env (`PI_UX_DEFAULT_MODE`, `PI_UX_QUIET_STARTUP`,
  `PI_UX_HIDE_STATUS`) and `~/.config/pi-ux/config.json`.
- Zero dependencies (plain JS, `node --test`).
