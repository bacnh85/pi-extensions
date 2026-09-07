---
name: ux-design
description: >
  Anti-slop UI/UX design discipline for AI-generated interfaces. Enforces
  industrial-design principles (Dieter Rams: honest, thorough to the last
  detail, as little design as possible) so output is a defensible system, not
  statistical-default slop (purple glow, shadow-as-texture, missing states).
  Covers the Constraint-First method: own the system via a lintable DESIGN.md,
  write a 5-field brief, generate inside constraints, normalise, render-and-inspect
  with vision (multimodal models see their own output), pass a measurable slop-audit
  gate. Works deterministically with text-only models
  (DeepSeek-v4, GLM-5.2, Kimi K3); agy/Gemini/Claude is optional polish, never
  the review gate. Use when designing or building any UI — web, mobile, or
  desktop. Active via /ux lite|strict|off.
argument-hint: ""
license: MIT
---

# UX Design Discipline — Anti-Slop, Industrial-Design Method

You implement UI INSIDE an existing design system. You do NOT invent visual
language. Slop fills the gaps you leave — so you stop leaving gaps. The system
is anchored by a repo-root **DESIGN.md** that every generation reads.

## The anti-slop guardrail (hard rules)

- **Tokens ONLY** — colour, type, spacing, radius, elevation. No off-system values.
- **Elevation:** named levels only (sm/md/lg/xl). Never invent shadow blur/opacity. A modal is nearer than a card; a dropdown nearer than the page — and it stays that way whoever edited last.
- **Accent:** ONLY the defined accent token. No purple/indigo gradients. No glow unless explicitly requested. (Glow is the #1 AI-slop signature.)
- **Type:** modular scale only (e.g. 1.25 ratio). No custom font sizes.
- **Spacing:** 8px grid via tokens. No magic pixel values.
- **States:** every interactive element declares `default`, `hover`, `focus-visible`, `active`, `disabled` + `error`/`empty`/`loading` where relevant. Anything that moves respects `prefers-reduced-motion`.
- **Inventory first:** before writing markup, output a 1-line inventory of components + states you will produce.
- **Ambiguity = ask.** If a requirement is ambiguous, ASK. Do not guess aesthetics.

## The Constraint-First method

### Step 0 — Own the system via DESIGN.md (the model must NEVER invent this)

**A repo-root `DESIGN.md` is the single source of truth the agent reads before
styling anything.** Without it, every generation drifts back to the
statistical average. So own the system BEFORE generating — but you do NOT have
to block: when DESIGN.md is missing, drop in a medium-tuned preset as the
implicit system and keep going (see below).

A DESIGN.md (Google Labs open standard) combines machine-readable design tokens
(YAML frontmatter: `colors`, `typography`, `rounded`, `spacing`, `components`)
with human-readable rationale (Overview → Colors → Typography → Layout →
Elevation → Shapes → Components → Do's & Don'ts). This is the anchor the
deterministic gate and the agent both read.

**Resolution order (stop at the first that holds):**
1. **Repo-root `DESIGN.md` exists** → read it; use its tokens verbatim. This is the happy path.
2. **An existing system is already wired in** (shadcn/MUI/Radix theme, Tailwind config) → reuse it — YAGNI applies to design systems too.
3. **A reference site exists** (brand to match, look to echo) → `web_extract` it and distill its design DNA (4–6 core hex, type roles, radius/spacing rhythm) into a DESIGN.md starter, lint it, then work inside it.
4. **Nothing exists** → do NOT block. Pick a **medium-tuned preset** from the `ux-presets` skill (B1 Web vs B2 Mobile — infer from the task; **ASK only if web-vs-mobile is genuinely unclear**, because it changes touch targets, hover, and safe areas). Use the preset **in-context as the implicit system** for this generation, then offer to persist it to repo-root `DESIGN.md` so future sessions reuse it (don't auto-write — that's an unrequested file mutation).
5. **No preset fits** → generate a DESIGN.md once with `agy_execute mode=plan pro-high` (Gemini); thereafter text-only models are sufficient.

The non-negotiables a preset/system must define before any screen is written:
- **Tokens:** colour (one accent + neutrals), type scale, spacing (8px grid), radius, elevation.
- **Elevation scale:** 3–5 named levels only. Map every shadow to one.
- **State contract:** every interactive component declares all states (web: + `:hover`/`:focus-visible`; mobile: + `:active`/pressed, NO hover); motion ships with a `prefers-reduced-motion` fallback.

**Lint the system (when persisted to disk):**
```bash
npx @google/design.md lint DESIGN.md
```
This validates token references, contrast, section order, and structure as structured JSON. pi-ux **orchestrates** `@google/design.md` via shell-out — it is NOT a runtime dependency (pi-ux stays zero-dep).

### Step 1 — The 5-field brief (one per screen)
All five are required. If you can't produce inventory + states with confidence, the work is under-specified — more generation will mostly manufacture cleanup debt.
1. **User job + success state** — one sentence.
2. **Screen inventory** — required components and actions.
3. **Token constraints** — palette, type, spacing, elevation (paste the DESIGN.md tokens).
4. **Required interaction states** per interactive component.
5. **One reference** screen/component that already feels like the product (brand tone).

**Generic-default check (before building):** if there is no DESIGN.md, sketch a mini plan first — 4–6 named hex, type roles, a one-line layout concept or ASCII wireframe, one principle. Then ask: *would I produce this same plan for any similar brief?* Every part that answers yes is a default, not a choice — revise it and say what changed.

**Scale to the task:** internal single-file tools → one-line brief + one draft is fine; user-facing product UI → full brief + 2–3 variants. The gates are the same either way.

### Step 2 — Generate fast, converge early
Generate several variants, commit early to the direction with the clearest hierarchy under real content.
- **Variants are files, not vibes:** write 2–3 drafts as separate HTML files (`.ux/drafts/<slug>-{a,b,c}.html`), screenshot each, view the images side by side, and commit to one direction before touching real code. When redesigning existing UI, first capture a BEFORE screenshot of the current page as reference context.
- **Convergence trigger:** after two generate-revise loops, variants must visibly converge toward your constraints. If they don't, tighten the brief first — prompting forever compounds drift.

### Step 3 — Normalise the draft into the system
Replace ad-hoc colours with tokens, remap shadows to the elevation scale, snap spacing to the rhythm, turn one-offs into component variants.
- Gate: sample 10 components, verify token mapping. If fewer than 8 map cleanly, stop and repair the baseline.

### Step 4 — Render & Inspect (vision verify — multimodal models)

The deterministic gates check CSS text; they never see the page. When the
generating model is multimodal (GLM-5.3, Claude, Gemini), close the
loop with eyes — this is the single biggest quality lever for flash-tier
models:

1. **Reference-first.** If the task gives a URL or screenshot as the design target, capture it with `web_screenshot` (pi-web 0.6.2+ returns the PNG inline) BEFORE generating. Every visual judgment is made against that reference.
2. **Inspect your own build.** Serve the UI (dev server or `python3 -m http.server`), then capture and LOOK — default: local headless Chrome + `read` (renders inline; commands in the `ux-capture` skill; offline, no daemon); alternative: `web_screenshot` (pi-web 0.6.2+) at a daemon-reachable address (full playbook in `ux-capture`). Fix what regex gates can't see: broken layout, weak hierarchy, spacing rhythm, brand fit. Batch fixes, re-screenshot, stop when converged (same 2-loop trigger as Step 2).
3. **Visibility baseline.** Judge at what a viewer sees at 1×–3×. Nothing sub-visible can fail, and nothing sub-visible may be produced — no ±1px claims, no per-pixel diffs, no instrument-read values on either side.
4. **Gates stay final.** `ux_audit` (Step 5) remains the blocking authority; vision settles only what looking can settle.

Text-only models, or no capture path at all (no headless Chrome, no reachable `web_screenshot`) → skip this step; the deterministic gates are the whole loop.

### Step 5 — Slop-audit gate (blocks handoff on fail)

Run `ux_audit` on the generated CSS. The contrast gate reports **APCA Lc**
(perceptual, primary — Lc ≥75 body / ≥45 large-bold / ≥30 non-text) with a
WCAG 2.x ratio sidecar for compliance reporting. APCA catches dark-theme +
thin-type slop that the legacy WCAG ratio misses. A 4th gate flags named AI
tells (glassmorphism, gradient orbs, neon glow, default-card).

| Gate | Pass | Fail action |
|---|---|---|
| Token coverage | ≥8/10 components map to tokens | Pause, repair baseline |
| Shadow recipes | ≤3 named recipes on core surfaces | Collapse to named elevations |
| Contrast (APCA) | Lc ≥75 body, ≥45 large-bold, ≥30 non-text (WCAG sidecar shown) | Block handoff until fixed |
| State coverage | all interactive elements have focus + disabled; any transition/animation ships a prefers-reduced-motion fallback | Keep in draft |
| Component hygiene | no duplicates, no frame-pile | Refactor before handoff |
| Slop tells | no glassmorphism / orbs / glow / default-card / 1px-gray-border / tracked-out eyebrow / tinted near-black bg | Refactor: space → bg shift → elevation before a border |

## Model routing (who does what)

Split the work along each model's strength. **The inversion rule:** the cheaper/weaker the model, the MORE you must externalise constraints. Taste lives in the brief, not the weights.

**The deterministic-first principle:** the gate is mechanical (DESIGN.md lint +
`ux_audit`), not a vision-LLM call. Text-only models now lead frontend
(Kimi K3 is #1 on the Arena.ai Frontend Code Arena, ahead of Claude Fable 5) —
inside a locked system they produce non-slop. agy/Gemini/Claude is optional,
never the review gate.

| Step | Best tool/model | Why |
|---|---|---|
| **Define system** (DESIGN.md: tokens, elevation, type) | Reuse a preset (ux-presets) OR `agy_execute mode=plan pro-high` (Gemini) **once** | Preset is cheapest. Gemini = strongest visual reasoning for the one-time scaffold. |
| **Lint system** | `npx @google/design.md lint DESIGN.md` (shell-out) | Deterministic token-ref + contrast + structure validation. |
| **Per-screen brief** | Main Pi model: **GLM-5.2** | 1M ctx holds the whole DESIGN.md while scoping one screen |
| **Generate variants** | Main Pi model: **DeepSeek-v4**, **GLM-5.2**, or **Kimi K3** | Text-only models lead frontend inside a locked system; cheaper than vision calls. |
| **Normalise into system** | Main Pi model: **DeepSeek-v4** or **GLM-5.2** | Long context, token remapping, mechanical precision |
| **Render & inspect** | The generating model itself, when multimodal (GLM-5.3, Claude, Gemini) via `web_screenshot` | Eyes on your own output beat rules in a prompt — flash-tier models produce notably better UI when they see the rendered result (inline image blocks) |
| **Slop audit** | `ux_audit` tool (deterministic) + DESIGN.md lint | Contrast (APCA) + token coverage + slop tells are computable, not judgement |
| **Optional polish** (never a gate) | `agy_execute mode=accept-edits sonnet` (Claude) or `opus` | Only if brand-fit is uncertain after the deterministic gate passes. NOT required. |

**Cross-family rule:** Gemini/Claude produce → deterministic gate reviews. Don't spend vision-model quota on what `ux_audit` computes for free. agy review is a fallback for aesthetic uncertainty, never the gate.

DeepSeek/GLM/Kimi K3 are safe for design **only inside a fully-specified system**. If no system exists yet, generate a DESIGN.md once (preset or agy), then text-only models are sufficient for every generation thereafter.

## Banned anti-patterns

These are auto-detected by `ux_audit`'s slop-tell gate — fail the gate and the
screen stays in draft until refactored.

- **Glassmorphism** (`backdrop-filter`) — faux depth that implies capability the feature lacks (violates "honest").
- **Gradient orbs / purple-indigo glow** (large-blur `radial-gradient`, coloured high-opacity `box-shadow`) — the #1 AI-slop signature, unless the brand explicitly calls for it.
- **Neon-on-dark** (cyan/violet glowing card borders) — the v0/Cursor signature.
- **The default card** (`rounded-2xl shadow-lg p-6` untouched shadcn reflex) — separate with whitespace → background shift → elevation, in that order; a border is the last resort.
- **1px gray card border** (`border-zinc`/`border-gray` defaults) — the most reliable AI tell.
- **Permanent dark mode** as the default reflex — the most common AI tell.
- Shadows as texture (drifting blur/opacity per component). Shadows = named elevation only.
- Magic pixel values; off-scale font sizes; ad-hoc accent colours.
- Shipping a component without `focus-visible` + `disabled` states.
- Prompting "make it modern/clean" with no DESIGN.md — the single biggest slop trigger.

### Named cliché clusters (credit: anthropics/skills frontend-design)
All legitimate for *some* briefs — but they are defaults, not choices, and appear regardless of subject. Where the brief pins a direction, follow it exactly; where an axis is free, don't spend it here:

- **The cream-clay look** — warm cream bg (near `#F4F1EA`) + high-contrast serif display + terracotta accent (near `#D97757`); on anyone else's brief it reads as Claude-flavoured.
- **Acid on black** — near-black background + single acid-green/vermilion accent.
- **Broadsheet kit** — hairline rules, zero border-radius everywhere, dense newspaper columns.
- **The SaaS-card kit** — identical rounded cards, one radius for everything, the same soft shadow under each, gradient washes as decoration.
- **Template chrome** — tracked-out ALL-CAPS eyebrow above every heading; meta strings joined with middle dots (`A · B · C`); `WORD — fragment` labels; tinted near-black (`#0B0B0B`, `#111`) standing in for black; monospace for small data labels; `→` appended to links/buttons.

## Taste rules

- **Ground it in the subject.** Distinctive choices come from the brief's industry, materials, and vernacular — a toy for kids and a trading dashboard should not share a visual language. If the subject is unclear, confirm it before designing.
- **Typography carries personality.** Choose typefaces deliberately per project (1–2 families, clearly distinct roles); body lines under ~80 chars. Never accent a single word of a headline; no ALL-CAPS labels by default; structural devices (numbers, rules, eyebrows) only when they encode real information — `01 / 02 / 03` is for actual sequences.
- **Motion: one orchestrated moment.** A single page-load sequence or reveal lands better than effects scattered everywhere; fade-and-slide-up on every section is an AI tell. Motion that answers an action (opening, confirming) is welcome. Always ship a `prefers-reduced-motion` fallback.
- **Design writing is design.** Use the user's words, not system words ("notifications", not "webhook config"). CTAs say what happens ("Save changes", not "Submit"); one name per action across the flow. Errors direct instead of apologising; empty states invite action.
- **Spend boldness in one place.** One memorable element; everything around it quiet and disciplined. Quality floor without announcing it: responsive, visible keyboard focus, reduced motion, accessible contrast.
- **Data-viz rules (dashboards & charts).** Chart fills must pass non-text contrast (≥3:1) against their track. Adjacent categorical fills must be nameably different, not opacity steps; cap ramps at 7. Secondary series ≤0.85 opacity or a muted token; today/selected gets full accent. Numeric cells get `font-variant-numeric: tabular-nums`. Empty/zero chart states show an axis or "no data" slot, never a blank canvas. Tables: row hover on bg, right-aligned numerics, sentence-case headers.
