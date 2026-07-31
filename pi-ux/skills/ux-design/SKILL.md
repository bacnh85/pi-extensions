---
name: ux-design
description: >
  Anti-slop UI/UX design discipline for AI-generated interfaces. Enforces
  industrial-design principles (Dieter Rams: honest, thorough to the last
  detail, as little design as possible) so output is a defensible system, not
  statistical-default slop (purple glow, shadow-as-texture, missing states).
  Covers the Constraint-First method: own the system, write a 5-field brief,
  generate inside constraints, normalise, pass a measurable slop-audit gate.
  Includes model routing: Gemini/Claude via agy_execute for generation and
  review, DeepSeek-v4 / GLM-5.2 as the main Pi models for briefs and
  normalisation. Use when designing or building any UI — web, mobile, or
  desktop. Active via /ux lite|strict|off.
argument-hint: ""
license: MIT
---

# UX Design Discipline — Anti-Slop, Industrial-Design Method

You implement UI INSIDE an existing design system. You do NOT invent visual
language. Slop fills the gaps you leave — so you stop leaving gaps.

## The anti-slop guardrail (hard rules)

- **Tokens ONLY** — colour, type, spacing, radius, elevation. No off-system values.
- **Elevation:** named levels only (sm/md/lg/xl). Never invent shadow blur/opacity. A modal is nearer than a card; a dropdown nearer than the page — and it stays that way whoever edited last.
- **Accent:** ONLY the defined accent token. No purple/indigo gradients. No glow unless explicitly requested. (Glow is the #1 AI-slop signature.)
- **Type:** modular scale only (e.g. 1.25 ratio). No custom font sizes.
- **Spacing:** 8px grid via tokens. No magic pixel values.
- **States:** every interactive element declares `default`, `hover`, `focus-visible`, `active`, `disabled` + `error`/`empty`/`loading` where relevant.
- **Inventory first:** before writing markup, output a 1-line inventory of components + states you will produce.
- **Ambiguity = ask.** If a requirement is ambiguous, ASK. Do not guess aesthetics.

## The Constraint-First method

### Step 0 — Own the system (the model must NEVER invent this)
If these don't exist, don't generate screens yet — keep the model in ideation mode.
- **Tokens:** colour (one accent + neutrals), type scale, spacing (8px grid), radius, elevation.
- **Elevation scale:** 3–5 named levels only. Map every shadow to one.
- **State contract:** every interactive component declares all states.
- Reuse an existing system (Material, shadcn/ui, Radix) — YAGNI applies to design systems too.

### Step 1 — The 5-field brief (one per screen)
All five are required. If you can't produce inventory + states with confidence, the work is under-specified — more generation will mostly manufacture cleanup debt.
1. **User job + success state** — one sentence.
2. **Screen inventory** — required components and actions.
3. **Token constraints** — palette, type, spacing, elevation (paste the tokens).
4. **Required interaction states** per interactive component.
5. **One reference** screen/component that already feels like the product (brand tone).

### Step 2 — Generate fast, converge early
Generate several variants, commit early to the direction with the clearest hierarchy under real content.
- **Convergence trigger:** after two generate-revise loops, variants must visibly converge toward your constraints. If they don't, tighten the brief first — prompting forever compounds drift.

### Step 3 — Normalise the draft into the system
Replace ad-hoc colours with tokens, remap shadows to the elevation scale, snap spacing to the rhythm, turn one-offs into component variants.
- Gate: sample 10 components, verify token mapping. If fewer than 8 map cleanly, stop and repair the baseline.

### Step 4 — Slop-audit gate (blocks handoff on fail)

| Gate | Pass | Fail action |
|---|---|---|
| Token coverage | ≥8/10 components map to tokens | Pause, repair baseline |
| Shadow recipes | ≤3 named recipes on core surfaces | Collapse to named elevations |
| Contrast | WCAG AA: 4.5:1 body, 3:1 large/UI | Block handoff until fixed |
| State coverage | all interactive elements have focus + disabled | Keep in draft |
| Component hygiene | no duplicates, no frame-pile | Refactor before handoff |

## Model routing (who does what)

Split the work along each model's strength. **The inversion rule:** the cheaper/weaker the model, the MORE you must externalise constraints. Taste lives in the brief, not the weights.

| Step | Best tool/model | Why |
|---|---|---|
| **Define system** (tokens, elevation, type) | `agy_execute mode=plan pro-high` (Gemini) OR reuse shadcn/Material | Gemini = strongest visual reasoning (~80% UI similarity). Or human-owned preset. |
| **Per-screen brief** | Main Pi model: **GLM-5.2** | 200K ctx holds the whole system doc while scoping one screen |
| **Generate variants** | `agy_execute mode=accept-edits flash-high` (Gemini) | Visual king, safe inside constraints |
| **Normalise into system** | Main Pi model: **DeepSeek-v4** or **GLM-5.2** | Long context, token remapping, mechanical precision |
| **Slop audit** | `ux_audit` tool (deterministic) | Contrast + token coverage are computable, not judgement |
| **Final review/polish** | `agy_execute mode=plan sonnet` (Claude) or `opus` | Cross-family review; Claude = structured, conservative |

**Cross-family rule:** Gemini produces → Claude-class reviews. Don't spend both quota groups on trivial tasks.

DeepSeek/GLM are safe for design **only inside a fully-specified system**. If no system exists yet, generate it with Gemini via `agy` first, or reuse a preset.

## Banned anti-patterns

- Purple/indigo glow gradients unless the brand explicitly calls for them.
- Shadows as texture (drifting blur/opacity per component). Shadows = named elevation only.
- Glassmorphism / faux-3D that implies capability the feature lacks (violates "honest").
- Magic pixel values; off-scale font sizes; ad-hoc accent colours.
- Shipping a component without `focus-visible` + `disabled` states.
- Prompting "make it modern/clean" with no tokens — the single biggest slop trigger.
