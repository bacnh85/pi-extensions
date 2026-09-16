---
name: ux-design
description: >
  Anti-slop UI/UX design discipline for AI-generated interfaces. Enforces
  industrial-design principles (Dieter Rams: honest, thorough to the last
  detail, as little design as possible) so output is a defensible system, not
  statistical-default slop (purple glow, shadow-as-texture, missing states) —
  and equally not the correct-but-forgettable default (Inter, blue accent,
  timid sizes). Covers the Constraint-First method: own the system via a
  lintable DESIGN.md, write a 5-field brief, DERIVE A DIRECTION from the
  subject (mood, type voice, color mood, signature element), generate inside
  constraints, normalise, render-and-inspect with vision, pass a measurable
  slop-audit gate. Works deterministically with text-only models
  (DeepSeek-v4, GLM-5.2, Kimi K3); agy/Gemini/Claude is optional polish, never
  the review gate. Use when designing or building any UI — web, mobile, or
  desktop. Active via /ux lite|strict|off.
argument-hint: ""
license: MIT
---

# UX Design Discipline — Direction + Anti-Slop, Industrial-Design Method

Design work has two moves, and skipping either produces slop:

1. **Discipline** — never drift into the statistical default: tokens only, named
   elevation, full states, none of the banned tells. (Steps 0–5 + the audit gate.)
2. **Direction** — always commit to a visual point of view drawn from the
   subject, before any markup. (Step 1.5 + the Direction playbook.)

Discipline without direction gives the correct-but-forgettable page — Inter,
a blue accent, white cards, timid sizes — that no design lead would ship.
Direction without discipline gives purple glow and missing states. The
repo-root **DESIGN.md** anchors the system; the **direction brief** anchors
the taste. You produce both.

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
4. **Nothing exists** → do NOT block. Pick a preset from the `ux-presets` skill (B1 Web / B2 Mobile neutral, or a style-direction starter — infer from the task; **ASK only if web-vs-mobile is genuinely unclear**, because it changes touch targets, hover, and safe areas). Use it **in-context as the implicit system** for this generation, then offer to persist it to repo-root `DESIGN.md` (don't auto-write — that's an unrequested file mutation). **A preset is a floor, not an identity:** Step 1.5 must still bend its display face, neutrals, and accent until the finished page could not be mistaken for the stock preset. If your page could be the untouched preset, you did not design.
5. **No preset fits** → generate a DESIGN.md once with `agy_execute mode=plan pro-high` (Gemini); thereafter text-only models are sufficient.

The non-negotiables a preset/system must define before any screen is written:
- **Tokens:** colour (one accent + tinted neutrals), type scale, spacing (8px grid), radius, elevation.
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

**Scale to the task:** internal single-file tools → one-line brief + one draft is fine; user-facing product UI → full brief + 2–3 variants. The gates are the same either way.

### Step 1.5 — Derive a direction (before any markup)

This is the taste step, and it is not optional for user-facing UI. From the
brief, extract the subject's **material** and commit to a direction brief.
Test for a real direction: *two different designers following it must produce
visibly different pages.* If they would produce the same page, you wrote a
default, not a direction — revise.

1. **Subject material** — industry, material, era, energy. "B2B invoicing" is a category; "the accountant's desk — paper, ink, ruled columns, stamps" is material. Design the material.
2. **Mood adjectives** — three, committed ("calm, ruled, exact"). "Modern, clean, minimal" are the absence of mood — banned as answers.
3. **Visual concept** — one line naming the world this page lives in ("an expedition logbook, not a travel-agency template"; "a ledger book, not an admin panel").
4. **Type voice** — display + body pairing from the Direction playbook table (or a deliberate off-table choice). Never default to Inter/system-ui when the subject has a voice.
5. **Color mood** — temperature, neutral tint, the one accent, written as hex (playbook below).
6. **Signature element** — the one memorable thing (playbook below). Exactly one.

Say the direction in one line before writing markup —
`Direction: <concept> · type <display>+<body> · palette <hex> · signature: <element>` —
then generate inside it. When you catch yourself mid-build reaching for a
stock choice, ask the generic-default question: *would I produce this same
plan for any similar brief?* Every yes is a default masquerading as a choice.

### Step 2 — Generate fast, converge early
Generate several variants, commit early to the direction with the clearest hierarchy under real content.
- **Variants are files, not vibes:** write 2–3 drafts as separate HTML files (`.ux/drafts/<slug>-{a,b,c}.html`), screenshot each, view the images side by side, and commit to one direction before touching real code. When redesigning existing UI, first capture a BEFORE screenshot of the current page as reference context.
- **Convergence trigger:** after two generate-revise loops, variants must visibly converge toward your constraints. If they don't, tighten the brief first — prompting forever compounds drift.

### Step 3 — Normalise the draft into the system
Replace ad-hoc colours with tokens, remap shadows to the elevation scale, snap spacing to the rhythm, turn one-offs into component variants.
- Gate: sample 10 components, verify token mapping. If fewer than 8 map cleanly, stop and repair the baseline.

### Step 4 — Render & Inspect (vision verify)

The deterministic gates check CSS text; they never see the page. When the
generating model is multimodal (GLM-5.3, Claude, Gemini) this step is
**REQUIRED in strict mode** — you see your own output, which is the single
biggest quality lever for flash-tier models. Skipping it is a gate failure
even when `ux_audit` passes. (Text-only models, or genuinely no capture path
→ skip; the deterministic gates are the whole loop.)

1. **Reference-first.** If the task gives a URL or screenshot as the design target, capture it with `web_screenshot` (pi-web 0.6.2+ returns the PNG inline) BEFORE generating. Every visual judgment is made against that reference.
2. **Inspect your own build.** Serve the UI (dev server or `python3 -m http.server`), then capture and LOOK — default: local headless Chrome + `read` (renders inline; commands in the `ux-capture` skill); alternative: `web_screenshot` at a daemon-reachable address (full playbook in `ux-capture`).
3. **The LOOK checklist** — at the **brief's target viewport** (mobile briefs: capture at exactly 390 wide; never widen the capture to make a problem invisible — that is cheating the loop). Fix every failure in one batch, re-capture, repeat (2-loop convergence trigger, then move on):
   - **Squint test:** three distinguishable levels of hierarchy? Does the eye land first where it should?
   - **Dead zones:** any region with nothing for the eye? Whitespace piling up on one side? On app screens: does content leave a large empty region below the last element at the target height?
   - **Monotony:** consecutive sections with identical weight/background? Every content group in the same box?
   - **Timidity:** cover the logo — could this page belong to anyone? Then amplify the display scale or the signature; the direction is not coming through.
   - **Type & overflow at target width:** display sizes actually large? measure comfortable? **any horizontal scroll, cut-off text, or squeezed badges at the target width?** orphans, cramped labels?
   - **Mood:** is the palette's temperature visible at a glance, or is it generic white+blue?
4. **Visibility baseline.** Judge at what a viewer sees at 1×–3×. Nothing sub-visible can fail, and nothing sub-visible may be produced — no ±1px claims, no per-pixel diffs, no instrument-read values on either side.
5. **Gates stay final.** `ux_audit` (Step 5) remains the blocking authority; vision settles only what looking can settle.

### Step 5 — Slop-audit gate (blocks handoff on fail)

Run `ux_audit` on the generated CSS. The contrast gate reports **APCA Lc**
(perceptual, primary — Lc ≥75 body / ≥45 large-bold / ≥30 non-text) with a
WCAG 2.x ratio sidecar for compliance reporting. APCA catches dark-theme +
thin-type slop that the legacy WCAG ratio misses.

| Gate (implemented in `ux_audit`) | Pass | Fail action |
|---|---|---|
| Contrast (APCA) | Lc ≥75 body, ≥45 large-bold, ≥30 non-text (WCAG sidecar shown) | Block handoff until fixed |
| Tokens | no hardcoded hex outside `:root` definitions; no ad-hoc box-shadows built from raw values | Move values into tokens / named elevations |
| States + motion | interactive elements have `:focus-visible` + `:disabled`; any transition/animation ships a `prefers-reduced-motion` fallback | Keep in draft |
| Slop tells | no glassmorphism / gradient orbs / neon glow / default-card / 1px-gray-border / tracked-out eyebrow / tinted near-black bg | Refactor: space → bg shift → elevation before a border |

**Model-side checks** (not mechanically gated — you verify): token mapping ≥8/10 sampled components; ≤3 named shadow recipes; no duplicate components. A 4th slop gate flags named AI tells automatically.

## Direction playbook (the positive layer)

The guardrail stops bad; the playbook produces good. Pull from it in Step 1.5.

### Typography voice

Choose deliberately; 1–2 families with clearly distinct roles. Inter/system-ui
is the statistical default this method exists to escape — reach past it unless
the subject is genuinely neutral infrastructure. Pairings that work (Google
Fonts; first = display, second = body):

| Subject voice | Pairing | Why it works |
|---|---|---|
| Editorial / literary / journal | **Newsreader** + **Source Sans 3** | serif display at 500–600, tight leading; body stays quiet |
| Expedition / outdoors / heritage | **Bricolage Grotesque 800** + **Newsreader** | heavy grotesque display over a serif body reads "printed field guide" |
| Financial / ledger / legal | **Spline Sans** + **Spline Sans Mono** | mono for every numeral, `tabular-nums`; ruled borders do the branding |
| Technical / infra / dev tool | **IBM Plex Sans** + **IBM Plex Mono** | personality from weight contrast + hairline rules, not decoration |
| Warm consumer / food / home | **DM Sans** 700–800 display + body | geometric warmth; personality from color + radius + scale |
| Dense data / dashboard | Spline Sans pair or IBM Plex pair | personality from rhythm and status-color discipline |

Cautions: the cream+Fraunces+terracotta and Space-Grotesk-on-dark looks are
named cliché clusters below. Off-table picks that still carry voice:
Archivo, Schibsted Grotesk, Libre Caslon Text, Spectral (displays);
Public Sans, Instrument Sans, Work Sans, Outfit (bodies).

Numbers that make type feel designed: marketing h1 ≥ `clamp(2.75rem, 7vw, 6.75rem)`
(≈96–108px at 1440 — the hero must dominate at 3–4× body size or the scale
step is wrong); section h2 ≥ 2rem; stat/metric numerals ≥ 2rem with
`tabular-nums`; display weight 700–800 against body 400; body 1rem–1.125rem/1.6
at 45–75ch; display letter-spacing −0.01 to −0.025em. Timid sizes are the #1
"no feel" symptom — when in doubt, bigger display, fewer words.

### Color mood construction

- **Temperature first:** warm or cool page? Then tint EVERY neutral with the mood hue at very low chroma — warm paper `#F6F4EE`, green-black ink `#22302A`, blue-gray desk `#F3F1EA`. Never pure `#fff`/`#000`.
- **One accent, posture committed:** deep + saturated (vermilion, forest, indigo, oxblood) beats bright + default. Pure blue `#0066FF` on white IS the default look. Test the accent's APCA pair before committing to it.
- **Support colors only when they encode meaning** (success/danger/warning), each with a soft tinted background for badges — never as decoration.
- **Bands give rhythm:** 2–3 background treatments across a page (paper → tinted → dark ink → paper). A dark band mid-page is a strong, cheap rhythm marker. Alternating white sections are not rhythm, they're fog.
- **Surface budget: three surfaces, one family.** Base, one warm/tinted mid, one inverse (dark) — all tinted by the same mood hue — plus the accent reserved for CTAs and marks. If the header/nav introduces a color the rest of the page never uses, delete it: the header inherits the base surface. Five unrelated surfaces read as template collage.

### Composition anatomy

- **Hierarchy = scale + weight + color contrast**, not shadow boxes. If hierarchy needs a shadow, the scale is broken.
- **Hero formula:** kicker (small, real information) → one big claim (display face, ≥3rem, ≤9 words) → one sub (≤2 lines) → one primary action. No gradient-blob backgrounds; the whitespace and type ARE the design.
- **Rows beat card grids** for repeated content (trips, features, invoices, episodes) — and a row is a **fixed column grid, not flowing text**: 4–5 columns at identical x-positions across all rows (identity left, one datum per middle column, terminal value — price/CTA — right-aligned on a shared axis), hairline separators, equal row heights. Metadata never wraps to a second line; if it doesn't fit the column, the copy is too long. If you must card, vary the span — one wide, two narrow.
- **Shaped whitespace:** asymmetric gutters, a deliberately wide margin around one element, rag that breathes. Whitespace is a material you place, not what's left over.
- **Depth via composition** — overlap, scale steps, band shifts — not glow or shadow-piles.

### The signature element

Exactly one memorable element, drawn from the subject, **scaled like
composition rather than framed like content**: ≥25% of the viewport wide,
allowed to bleed off the canvas edge, set at reduced contrast so it reads as
atmosphere — never a small bordered "illustration card" smaller than the
headline it sits beside. Forms that work: an oversized glyph or numeral from
the subject's own writing system, a rotated stamp/seal, index numerals treated
as design objects, a contour/texture system that fills the hero, one
full-bleed moment. Everything else stays quiet. If you cannot name your
signature element, you don't have one — and the page will be forgettable.

### The punctuation kit (authored details, 2–3 per viewport)

Small deliberate marks are the difference between "clean" and "authored":

- one accent-colored terminal on the H1 (a colored period, a final word);
- pull quotes framed by a bracket, rule, or oversized mark — not a floating italic slab;
- one stamp/seal/badge marking the page's scarcity or guarantee claim;
- texture glyphs from the subject's language on repeated items (JP kanji beside route names, §, №, coordinates);
- terminal marks as data affordances (an arrow on prices/rows) — but NEVER appended to every link/button (that is the template-chrome cliché below).

Placeholder monograms (initials in a circle) are not punctuation — replace
them with role labels and one real credential line.

### Default vs directed (feel the difference)

- *Default:* `Inter`, `#111` on `#fff`, `h1{font-size:2.5rem}`, blue button, three equal cards.
- *Directed (same brief, "ledger" concept):* Spline Sans + mono `tabular-nums`, desk `#F3F1EA`, ruled table borders, one rotated `OVERDUE` stamp badge, forest accent `#1E6B50`.

Same effort. One is a page; the other is a template.

## Model routing

The who-does-what table lives in the `ux-routing` skill (not injected). Always
true: **the deterministic gate reviews; a multimodal model looks at its own
render; taste lives in the direction brief, not the model choice.**

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
- Prompting "make it modern/clean" with no DESIGN.md and no direction — the single biggest slop trigger.

### Named cliché clusters (credit: anthropics/skills frontend-design)
All legitimate for *some* briefs — but they are defaults, not choices, and appear regardless of subject. Where the brief pins a direction, follow it exactly; where an axis is free, don't spend it here:

- **The cream-clay look** — warm cream bg (near `#F4F1EA`) + high-contrast serif display + terracotta accent (near `#D97757`); on anyone else's brief it reads as Claude-flavoured.
- **Acid on black** — near-black background + single acid-green/vermilion accent.
- **Broadsheet kit** — hairline rules, zero border-radius everywhere, dense newspaper columns.
- **The SaaS-card kit** — identical rounded cards, one radius for everything, the same soft shadow under each, gradient washes as decoration.
- **Template chrome** — tracked-out ALL-CAPS eyebrow above every heading; meta strings joined with middle dots (`A · B · C`); `WORD — fragment` labels; tinted near-black (`#0B0B0B`, `#111`) standing in for black; monospace for small data labels; `→` appended to links/buttons.

## Taste rules

- **Ground it in the subject.** Distinctive choices come from the brief's industry, materials, and vernacular — a toy for kids and a trading dashboard should not share a visual language. If the subject is unclear, confirm it before designing.
- **Typography carries personality.** Choose typefaces deliberately per project (1–2 families, clearly distinct roles — the playbook table is the starting point, not the ceiling); body lines under ~80 chars. Never accent a single word of a headline; no ALL-CAPS labels by default; structural devices (numbers, rules, eyebrows) only when they encode real information — `01 / 02 / 03` is for actual sequences.
- **Motion: one orchestrated moment.** A single page-load sequence or reveal lands better than effects scattered everywhere; fade-and-slide-up on every section is an AI tell. Motion that answers an action (opening, confirming) is welcome. Always ship a `prefers-reduced-motion` fallback.
- **Design writing is design.** Use the user's words, not system words ("notifications", not "webhook config"). CTAs say what happens ("Save changes", not "Submit"); one name per action across the flow. Errors direct instead of apologising; empty states invite action. In a screenshot test, placeholder names ("Acme", "Lorem", "Feature One") read as template — write real content even in drafts.
- **Spend boldness in one place.** One memorable element (the signature); everything around it quiet and disciplined. Quality floor without announcing it: responsive, visible keyboard focus, reduced motion, accessible contrast.
- **Data-viz rules (dashboards & charts).** Chart fills must pass non-text contrast (≥3:1) against their track. Adjacent categorical fills must be nameably different, not opacity steps; cap ramps at 7. Secondary series ≤0.85 opacity or a muted token; today/selected gets full accent. Numeric cells get `font-variant-numeric: tabular-nums`. Empty/zero chart states show an axis or "no data" slot, never a blank canvas. Tables: row hover on bg, right-aligned numerics, sentence-case headers.
