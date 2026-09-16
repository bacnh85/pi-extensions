---
name: ux-presets
description: >
  Reference design-system presets for ux-design. Anti-slop shortcuts: instead of
  inventing tokens, elevation, and state contracts from scratch, reuse one of
  these battle-tested systems (shadcn/ui, Material 3, Radix), drop in a
  medium-tuned DESIGN.md starter (Web or Mobile), or adopt a style-direction
  starter (Editorial print, Ledger, Warm consumer) that already carries a point
  of view. Use when starting a new UI project with no existing design system,
  when Step 0 (Own the system) of the ux-design method has nothing to reuse,
  or when asked for a starter token set. These are REFERENCES only —
  pi-ux never bundles CSS.
argument-hint: ""
license: MIT
---

# UX System Presets — anti-slop shortcuts for Step 0

The Constraint-First method starts at "Own the system." If the project has no
tokens / elevation scale / state contract, you do NOT have to block generation —
**reuse an existing system** or **drop in a medium-tuned DESIGN.md starter** as
the implicit system. This skill is the shortcut drawer for both.

## Option A — reuse an existing system (preferred, YAGNI)

| System | When | Install |
|---|---|---|
| **shadcn/ui** | React/Next, want copy-in components you own | `npx shadcn@latest init` — copies component source into your repo, not a dependency |
| **Material 3 (MUI)** | Want the full Material system, theming maturity | `@mui/material` + MUI theme — elevation, states, colour system all defined |
| **Radix UI Primitives** | Want unstyled, accessible primitives (dialogs, menus, popovers) you style yourself | `@radix-ui/react-*` — focus/disabled/aria handled correctly already |
| **Park UI / Ark UI** | Multi-framework, headless + styled variants | Ark UI primitives + Park UI recipes |

These already define tokens, 3–5 elevation levels, and full state contracts —
which is exactly what the anti-slop guardrail demands. **Reusing beats
redefining.** YAGNI applies to design systems too.

### Named styles (Claymorphism, Brutalism, Bento, Art Deco, …)

When the brief calls for a *named aesthetic* (a kids app wants Claymorphism;
an agency site wants Brutalism), **do not invent one and do not hand-copy a
template blindly.** Pull the canonical, lintable `DESIGN.md` from the
**[design.md style library](https://designmd.app/library)** (30+ styles,
same `DESIGN.md` standard this skill uses) and run it through the gate:

1. Fetch the style's `DESIGN.md` from `designmd.app/library/<style>`.
2. `npx @google/design.md lint DESIGN.md` (token-ref + structure validation).
3. `ux_audit` on the CSS + the style's common text pairs — **block handoff on fail.**

> **No style is pre-approved.** Named-style templates are aesthetic
> starting points, not vetted systems. The stock **Claymorphism** template
> ships a button in lilac (`#E6E6FA`) text on peach (`#FDBCB4`) — that pair
> fails `ux_audit` at **Lc −15.67** (WCAG 1.31:1). Correct it to ink-on-peach
> (Lc 75.72 ✓) before trusting it. The gate, not the template, makes a style
> non-slop. Note: glassmorphism and neumorphism are **banned** slop tells
> here regardless of any library entry.

## Option B — medium-tuned DESIGN.md starters (lintable, drop-in)

When there's nothing to reuse AND no repo-root DESIGN.md, pick the starter
matching the medium and use it **in-context as the implicit system** — then
keep generating. This is how the agent stays unblocked and non-slop when
DESIGN.md is absent. Lint it (and optionally persist it to repo root) when the
user wants to keep it:

```bash
npx @google/design.md lint DESIGN.md
```

### Which medium? (infer, then ask only if genuinely unclear)

- **Web** — landing page, dashboard, marketing site, admin panel, "responsive", docs, anything mouse + keyboard. Default when the target is a browser at desktop/tablet width.
- **Mobile** — "iOS/Android app", native (SwiftUI/Kotlin), React Native/Flutter, mobile-first PWA, "screen" for a phone, anything touch-first.
- Ambiguous (e.g. "a screen", no platform) → **ASK** which medium; do not guess. This is the one decision worth a question, because it changes touch targets, hover, and safe areas.

### B1 — Web preset (mouse + keyboard, responsive)

```markdown
---
name: Web Baseline
description: Anti-slop web system — one accent + neutrals, hover + focus-visible, desktop type scale, 65ch measure.
colors:
  primary: "#111111"
  accent: "#0066ff"
  accent-hover: "#0052cc"
  text: "#111111"
  text-muted: "#595959"
  bg: "#ffffff"
  surface: "#f7f7f8"
  border: "#e4e4e7"
  danger: "#c2261b"
  success: "#15803d"
typography:
  body:
    fontFamily: Inter
    fontSize: 1rem
    lineHeight: 1.6
  h1:
    fontFamily: Inter
    fontSize: 2.441rem
    fontWeight: 700
    lineHeight: 1.15
  h2:
    fontFamily: Inter
    fontSize: 1.953rem
    fontWeight: 700
  label:
    fontFamily: Inter
    fontSize: 0.8rem
    fontWeight: 600
    letterSpacing: 0.02em
rounded:
  sm: 6px
  md: 10px
  lg: 14px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
---

## Overview

Desktop/responsive web. One accent, neutral surfaces, hierarchy by weight.
Separation by whitespace → background shift → elevation, in that order; a border
is the last resort.

## Colors

- **primary (#111111):** deep ink for headlines and primary text.
- **accent (#0066ff):** the sole driver for interaction. The ONE knob to swap for brand.
- **text-muted (#595959):** secondary copy, captions, metadata.
- **bg/surface:** warm-tinted off-whites, softer than pure white. Tint pure black/white warm or cool for depth.
- **danger/success:** reserved for semantic state, never decoration.

## Typography

Inter, hierarchy by weight on a 1.25 modular scale. Body at 1rem / 1.6 line-height.
Hold the measure (line length) to 60–80 characters for readability.

## Layout

- 8px spacing grid; no magic pixel values. Section padding varies so hero/content/CTA don't feel the same weight.
- Responsive: max-width container (e.g. 1152px), 12-column awareness, breakpoints at 640/768/1024/1280.

## Elevation & Depth

Map EVERY shadow to a named level — never invent blur/opacity per component:
`sm` resting card · `md` raised/dropdown · `lg` popover · `xl` modal.

## Do's and Don'ts

- DO declare `default` / `hover` / `focus-visible` / `active` / `disabled` for every interactive element — keyboard nav is primary on web.
- DON'T use `backdrop-filter`, gradient orbs, coloured glow, or a 1px gray card border — the AI-slop signatures.
- DON'T ship pure `#fff`/`#000`; tint them.
```

### B2 — Mobile preset (touch-first, native / RN / mobile web)
```markdown
---
name: Mobile Baseline
description: Anti-slop mobile system — 44pt touch targets, no hover (tap/active), safe-area insets, 16px base (no zoom).
colors:
  primary: "#111111"
  accent: "#0066ff"
  accent-pressed: "#0052cc"
  text: "#111111"
  text-muted: "#595959"
  bg: "#ffffff"
  surface: "#f7f7f8"
  border: "#e4e4e7"
  danger: "#c2261b"
typography:
  body:
    fontFamily: Inter
    fontSize: 1rem
    lineHeight: 1.5
  h1:
    fontFamily: Inter
    fontSize: 1.953rem
    fontWeight: 700
    lineHeight: 1.2
  h2:
    fontFamily: Inter
    fontSize: 1.563rem
    fontWeight: 700
  label:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: 600
rounded:
  sm: 8px
  md: 12px
  lg: 16px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: 48px
    padding: "{spacing.md} {spacing.lg}"
  button-primary-pressed:
    backgroundColor: "{colors.accent-pressed}"
  tap-target:
    height: 44px
    width: 44px
  list-row:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    padding: "{spacing.md} {spacing.lg}"
  tab-bar:
    backgroundColor: "{colors.bg}"
    height: 56px
---

## Overview

Touch-first mobile (iOS / Android / React Native / Flutter / mobile web). One
accent, generous gutters, thumb-reach layout. Interaction is TAP, not hover.

## Colors

- **primary (#111111):** ink for headings and primary text.
- **accent (#0066ff):** the sole driver for interaction. The ONE knob to swap for brand.
- **accent-pressed:** replaces hover — the feedback state for a tap.
- **bg/surface:** layered to separate content; tint pure black/white warm or cool.

## Typography

Inter on a 1.2 scale. **Body at 16px minimum** — below 16px, iOS Safari
auto-zooms on input focus, which is slop. Hierarchy by weight, not by shrinking
the body.

## Layout

- 16px gutters, 24px section padding (thumb ergonomics).
- Thumb zone: primary actions reachable from the bottom third; place destructive actions away from the thumb arc.
- Safe-area insets for notch and home indicator: `env(safe-area-inset-top/bottom)` (web), or platform safe-area guides (native).
- Bottom-anchored patterns: tab bar, bottom sheet, FAB.

## Elevation & Depth

Named levels only: `sm` resting · `md` raised sheet · `lg` modal. A bottom sheet
is nearer than the page — keep it that way.

## Do's and Don'ts

- DO make every interactive element ≥ 44pt (iOS HIG) / 48dp (Material) — the #1 thing models get wrong.
- DO use `:active` / pressed states for tap feedback — there is NO hover on touch. Do not ship `:hover`-only feedback.
- DO respect safe areas (notch, home indicator, keyboard).
- DON'T use `backdrop-filter`, gradient orbs, coloured glow, or 1px gray borders — AI-slop signatures on mobile too.
- DON'T set body text below 16px (triggers iOS zoom).
- iOS vs Android: follow the host platform — iOS HIG (SF symbols, larger corner radius, sheet) vs Material 3 (FAB, ripple, top app bar).
```

## Option B+ — style-direction starters (a floor WITH a point of view)

B1/B2 are deliberately neutral — they pass the gates but carry no identity, and
a project that keeps them untouched ships the "correct but forgettable" page.
The three starters below pair the same gate-hardened token structure with a
**subject material and type voice**, so Step 1.5 starts from a direction
instead of a blank. Pick the one whose material matches the brief; then still
bend it (Step 1.5): swap the accent to the subject's world, adjust the mood
adjectives, and commit a signature element of your own. All pairs below were
verified against the APCA ladder (Lc ≥75 body · ≥45 large · ≥60 small-bold
badges).

### S1 — Editorial print (journal, heritage brand, long-form, portfolio)

Material: the printed page — warm paper, ink, hairline rules. Near-square
corners; separation by rules and whitespace, elevation almost never. Display
**Newsreader** (500–600, tight leading) over **Source Sans 3** body.

```yaml
name: Editorial Print
colors:
  bg: "#F6F2E9"          # warm paper
  surface: "#EEE8DA"     # shaded paper band
  text: "#20241F"        # ink
  text-muted: "#565B50"
  accent: "#7D2B25"      # oxblood — links, rules, stamps
  accent-hover: "#67241E"
  border: "#DBD3C2"      # hairline
  danger: "#9B2C20"
typography:
  body:   { fontFamily: "Source Sans 3", fontSize: 1.0625rem, lineHeight: 1.65 }
  h1:     { fontFamily: Newsreader, fontSize: 3rem, fontWeight: 600, lineHeight: 1.1 }
  h2:     { fontFamily: Newsreader, fontSize: 2.1rem, fontWeight: 600 }
  label:  { fontFamily: "Source Sans 3", fontSize: 0.85rem, fontWeight: 600 }
rounded:  { sm: 2px, md: 2px, lg: 3px }   # print is square
components:
  ruled-row:   { borderTop: "1.5px solid {colors.text}", padding: "{spacing.md} 0" }
  link:        { color: "{colors.accent}", textDecorationThickness: "1px" }
  button-quiet: { border: "1.5px solid {colors.text}", color: "{colors.text}", rounded: "{rounded.sm}" }
  stamp:       { color: "{colors.accent}", border: "2px solid {colors.accent}", transform: "rotate(-2deg)" }
```

Do: rules over shadows (border hierarchy); generous margins around display
type; numerals and folios as design objects. Don't: shadows bigger than
`--elev-sm`; rounded-2xl softness; dark mode (this system IS paper).

### S2 — Ledger (finance, invoicing, dense data, legal, ops dashboards)

Material: the accountant's desk — desk paper, cards, ruled columns, stamps.
Every numeral in the mono face with `font-variant-numeric: tabular-nums`.
Display **Spline Sans** + **Spline Sans Mono** for all data.

```yaml
name: Ledger
colors:
  bg: "#F3F1EA"          # desk
  surface: "#FCFBF7"     # card
  text: "#1C211E"        # ink
  text-muted: "#5B625D"
  accent: "#1E6B50"      # ledger green — buttons, positive
  accent-text: "#17573F" # green as TEXT on desk/card (Lc 79-81)
  accent-hover: "#155640"
  danger: "#B0362A"      # stamp text on #F4E3E0 (small-bold ≥600)
  warning: "#8A6210"     # stamp text on #F2EAD4 (small-bold ≥600)
  border: "#E0DDD2"
  rule: "#1C211E"        # 1.5px structural rules — the branding
typography:
  body:   { fontFamily: "Spline Sans", fontSize: 0.9rem, lineHeight: 1.5 }
  data:   { fontFamily: "Spline Sans Mono", fontWeight: 500, fontVariantNumeric: tabular-nums }
  h1:     { fontFamily: "Spline Sans", fontSize: 1.5rem, fontWeight: 700, letterSpacing: "-0.015em" }
  label:  { fontFamily: "Spline Sans Mono", fontSize: 0.6875rem, fontWeight: 500, letterSpacing: "0.08em", textTransform: uppercase }
rounded:  { sm: 3px, md: 6px, lg: 8px }
components:
  panel:        { backgroundColor: "{colors.surface}", border: "1.5px solid {colors.rule}", rounded: "{rounded.md}" }
  kpi-value:    { font: "{typography.data}", fontSize: 1.6875rem, fontWeight: 600 }
  status-paid:  { color: "{colors.accent-text}", backgroundColor: "#E2EEE7", fontWeight: 700, fontSize: "0.65rem" }
  status-overdue: { color: "{colors.danger}", backgroundColor: "#F4E3E0", fontWeight: 700, fontSize: "0.65rem", transform: "rotate(-2deg)" }
  table-head:   { font: "{typography.label}", borderBottom: "1.5px solid {colors.rule}" }
```

Do: structural 1.5px rules; status badges as stamps (soft bg + dark text);
KPI strip as one ruled panel, not four floating cards. Don't: pastel
dashboards with soft shadows everywhere; chart fills lighter than 3:1 against
the track; intercom-blue accents.

### S3 — Warm consumer (food, home, family, habits, kitchen/bath apps)

Material: warm kitchen linen. Chunky friendly radii, one deep green spine,
freshness told in color (fresh/expiring/expired), oversized action. Display
**DM Sans** 700–800.

```yaml
name: Warm Consumer
colors:
  bg: "#FAF6EE"          # linen
  surface: "#FFFFFF"     # card
  text: "#27302A"
  text-muted: "#5C6457"  # passes on BOTH linen and white
  accent: "#2F6B3C"      # basil — FAB, primary actions
  accent-pressed: "#245430"
  accent-soft: "#E5F0E2"
  danger: "#A93222"      # expired badge text on #F8E3DD (bold)
  warning: "#8A5D0B"     # expiring badge text on #F7ECD4 (bold)
  border: "#EAE4D6"
typography:
  body:   { fontFamily: "DM Sans", fontSize: 1rem, lineHeight: 1.45 }
  h1:     { fontFamily: "DM Sans", fontSize: 1.4375rem, fontWeight: 800, letterSpacing: "-0.02em" }
  badge:  { fontFamily: "DM Sans", fontSize: 0.65625rem, fontWeight: 700, letterSpacing: "0.03em" }
rounded:  { sm: 12px, md: 16px, lg: 22px }
components:
  list-row:    { backgroundColor: "{colors.surface}", border: "1.5px solid {colors.border}", rounded: "{rounded.md}", padding: "12px 14px" }
  category-spine: { position: absolute, left: 0, width: 5px, backgroundColor: "{category-color}" }
  fab:         { backgroundColor: "{colors.accent}", color: "#F2F7EE", rounded: 999px, padding: "16px 26px", fontWeight: 800 }
  badge-soon:  { color: "{colors.warning}", backgroundColor: "#F7ECD4" }
  badge-expired: { color: "{colors.danger}", backgroundColor: "#F8E3DD" }
```

Do: category color spines (5px, left edge); FAB as the page's one loud
element; header bands in the accent color. Don't: neon or candy gradients;
hover-only feedback (touch medium — use B2's tap rules); body below 16px.

Mobile adaptation: any S-starter keeps its palette/type and takes B2's
mechanics (44pt targets, `:active` states, safe areas, thumb zone).

## Option C — minimal `:root` token set (CSS-only, no DESIGN.md)

For CSS-only projects that do not adopt DESIGN.md, drop this compact baseline
into the project's `:root`. It satisfies the token + elevation + state gates of
`ux_audit` with ~20 lines. Prefer Option B when the project can adopt DESIGN.md
— it is lintable, diffable, and medium-tuned; this is the plain fallback.

```css
:root {
  /* Colour — one accent + neutrals. No purple glow. */
  --accent: #0066ff;          /* swap for the brand accent; ONE accent only */
  --accent-hover: #0052cc;
  --text: #111111;
  --text-muted: #595959;
  --bg: #ffffff;
  --surface: #f7f7f8;
  --border: #e4e4e7;
  --danger: #c2261b;

  /* Type — modular scale (ratio 1.25). No custom sizes. */
  --text-sm: 0.8rem;
  --text-base: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.563rem;
  --text-2xl: 1.953rem;

  /* Spacing — 8px grid. No magic pixels. */
  --space-1: 4px;   /* half-step for hairlines only */
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;
  --space-5: 32px;
  --space-6: 48px;

  /* Radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;

  /* Elevation — 4 named levels. Map EVERY shadow to one of these. */
  --elev-sm: 0 1px 2px rgba(0,0,0,0.05);
  --elev-md: 0 2px 8px rgba(0,0,0,0.08);
  --elev-lg: 0 8px 24px rgba(0,0,0,0.12);
  --elev-xl: 0 16px 48px rgba(0,0,0,0.16);
}

/* State contract — interactive elements MUST declare these. */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
:disabled { opacity: 0.5; cursor: not-allowed; }
```

## How to use with ux-design

1. Run **Step 0** of ux-design. If the project already has a DESIGN.md / tokens / elevation / states → use them.
2. If not, pick **Option A** — reuse an installed system (shadcn/Material/Radix) when the stack matches, OR pull a named style (Claymorphism, Brutalism, …) from the design.md library. Both reuse-before-invent; both still must pass `ux_audit`.
3. Otherwise pick **Option B** — infer the medium (Web B1 vs Mobile B2) from the task, use the starter in-context as the implicit system, and keep generating. Only ASK if web-vs-mobile is unclear. When the subject's material clearly matches a style-direction starter (**S1 Editorial print / S2 Ledger / S3 Warm consumer**), prefer it over the neutral B-starter — it hands Step 1.5 a direction for free.
4. Only for CSS-only projects that won't adopt DESIGN.md, use **Option C** (`:root` block).
5. Generate screens with any text-only model (DeepSeek-v4 / GLM-5.2 / Kimi K3) INSIDE these constraints.
6. Run `ux_audit` with the CSS + the most common text colour pairs before handoff.

**Floors, not identities:** whichever starter you pick, Step 1.5 of ux-design still bends it — accent toward the subject's world, mood adjectives committed, one signature element named. The finished page must not be recognisable as the stock starter.

## Audit-ready pairs

```jsonc
// Pass these to ux_audit.pairs to check a baseline itself.
// weight/size enable the APCA thresholds; min is the WCAG compliance sidecar.
[
  { "fg": "#111111", "bg": "#ffffff", "label": "body",        "min": 4.5, "weight": 400, "size": 16 },
  { "fg": "#595959", "bg": "#ffffff", "label": "muted",       "min": 4.5, "weight": 400, "size": 16 },
  { "fg": "#0066ff", "bg": "#ffffff", "label": "accent-link", "min": 4.5, "weight": 400, "size": 16 },
  { "fg": "#ffffff", "bg": "#0066ff", "label": "button",      "min": 4.5, "weight": 600, "size": 16 },
  { "fg": "#c2261b", "bg": "#ffffff", "label": "danger",      "min": 4.5, "weight": 400, "size": 16 }
]
```

## What this preset is NOT

- Not a CSS framework — reference only. Don't bundle it; copy what you need.
- Not themeable at runtime — it's a baseline to extend, not a product.
- Not opinionated about the accent — `accent` / `{colors.accent}` is the ONE knob you turn for brand.
- Not an identity — even the S-starters are floors. A finished page that looks exactly like its starter means Step 1.5 was skipped.
