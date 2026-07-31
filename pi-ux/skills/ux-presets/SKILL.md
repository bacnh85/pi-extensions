---
name: ux-presets
description: >
  Reference design-system presets for ux-design. Anti-slop shortcuts: instead of
  inventing tokens, elevation, and state contracts from scratch, reuse one of
  these battle-tested systems (shadcn/ui, Material 3, Radix) or copy a compact
  token set into the project. Use when starting a new UI project with no
  existing design system, when Step 0 (Own the system) of the ux-design method
  has nothing to reuse, or when asked for a starter token set. These are
  REFERENCES only — pi-ux never bundles CSS.
argument-hint: ""
license: MIT
---

# UX System Presets — anti-slop shortcuts for Step 0

The Constraint-First method starts at "Own the system." If the project has no
tokens / elevation scale / state contract, do NOT generate screens yet — either
**reuse an existing system** or **copy a compact token set**. This skill is the
shortcut drawer for both.

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

## Option B — minimal token set (when no framework, or CSS-only)

When there's nothing to reuse, drop this compact baseline into the project's
`:root` and point the guardrail at it. It satisfies all three audit gates
(tokens, elevation, states) with ~20 lines.

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

1. Run **Step 0** of ux-design. If the project already has tokens/elevation/states → use them.
2. If not, pick **Option A** (reuse shadcn/Material/Radix) first. This is the lazy, correct path.
3. Only if nothing fits, copy **Option B** into the project and adapt `--accent` to the brand.
4. Generate screens with `agy flash-high` INSIDE these constraints.
5. Run `ux_audit` with the CSS + the 5 most common text colour pairs before handoff.

## Audit-ready pairs for the minimal set

```jsonc
// Pass these to ux_audit.pairs to check the baseline itself.
[
  { "fg": "#111111", "bg": "#ffffff", "label": "body",       "min": 4.5 },
  { "fg": "#595959", "bg": "#ffffff", "label": "muted",      "min": 4.5 },
  { "fg": "#0066ff", "bg": "#ffffff", "label": "accent-link","min": 4.5 },
  { "fg": "#ffffff", "bg": "#0066ff", "label": "button",     "min": 4.5 },
  { "fg": "#c2261b", "bg": "#ffffff", "label": "danger",     "min": 4.5 }
]
```

## What this preset is NOT

- Not a CSS framework — reference only. Don't bundle it; copy what you need.
- Not themeable at runtime — it's a baseline to extend, not a product.
- Not opinionated about the accent — `--accent` is the ONE knob you turn for brand.
