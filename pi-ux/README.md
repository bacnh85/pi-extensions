# pi-ux

Anti-slop UI/UX design discipline for the [Pi coding agent](https://pi.dev). Anchors a lintable **DESIGN.md**, **derives a design direction** (mood, type voice, color mood, signature element) from the subject, runs **deterministic** slop-audit gates (APCA contrast + tokens + states + slop tells), and works **with text-only models** (DeepSeek-v4, GLM-5.2, Kimi K3) — `agy`/Gemini/Claude is optional polish, never the review gate.

## Why

AI-generated UI fails in two directions. Without discipline it converges on slop — purple/indigo glow, shadow-heavy cards, missing focus/disabled/error states. Without direction it converges on the *correct but forgettable* default — Inter, a blue accent, white cards, timid sizes — which passes every lint and still has no feel, because under vague direction models reach for high-frequency statistical patterns either way. The fix is both halves: **own the system** in a DESIGN.md, **derive a direction** from the subject, then gate deterministically.

**Text-only models now lead frontend** (Kimi K3, an open MIT model, is #1 on the Arena.ai Frontend Code Arena, ahead of Claude Fable 5). Inside a fully-specified system they produce non-slop UI — which means the review gate can be mechanical, not a vision-LLM call.

## Install

```bash
pi install npm:@bacnh85/pi-ux
```

Pi auto-discovers the extension and skill.

## Usage

```
/ux              # reset to configured default mode
/ux strict       # guardrail + enforce ux_audit gate before handoff (default)
/ux lite         # guardrail only (ideation, exploration)
/ux off          # disable
/ux status       # current + default mode
/ux default lite # persist default mode
```

The guardrail is injected into the system prompt on every agent start while active. Turn off with `/ux off` or the phrases "stop ux" / "normal mode".

## Modes

| Mode | Behavior |
|------|----------|
| `off` | No guardrail |
| `lite` | Anti-slop guardrail enforced; audit gate recommended but not blocking |
| `strict` (default) | Guardrail + enforce `ux_audit` gate before declaring a screen done |

## The method

The injected skill enforces **Constraint-First Design Generation**:

0. **Own the system via DESIGN.md** — a repo-root `DESIGN.md` (Google Labs open standard: YAML token frontmatter + rationale) is the single source of truth. Lint it before generating:
   ```bash
   npx @google/design.md lint DESIGN.md
   ```
   If absent, reuse a preset or style-direction starter (`ux-presets` skill: shadcn/Material/Radix; S1 Editorial print / S2 Ledger / S3 Warm consumer) or scaffold one once. Presets are floors, not identities. pi-ux orchestrates `@google/design.md` via shell-out — **not** a runtime dependency.
1. **5-field brief per screen** — user job, inventory, token constraints, required states, one reference.
1.5. **Derive a direction** — from the subject's material, commit to mood adjectives, a one-line visual concept, a type voice (pairing table), a color mood (hex), and one signature element — before any markup. The test: two different designers following the direction must produce visibly different pages.
2. **Generate fast, converge early** — text-only models inside the locked system; 2-loop convergence trigger.
3. **Normalise** the draft back into tokens/elevation/spacing.
4. **Render & Inspect** (multimodal models; required in strict mode) — reference-first capture, then screenshot your own build and LOOK against a concrete checklist (squint test, dead zones, monotony, timidity, type, mood). Default: local headless-Chrome capture read back inline (offline, no daemon); alternative: `web_screenshot` (pi-web 0.6.2+, PNG returned inline) at a daemon-reachable address. Judge at viewer resolution (1×–3×); never chase sub-visible precision. Skip when text-only — the deterministic gates are the whole loop.
5. **Slop-audit gate** — run `ux_audit` (measurable): APCA contrast, token coverage, state coverage, slop tells, tracked-eyebrow/near-black taste tells, reduced-motion coverage.

The **Direction playbook** ships in the skill as the positive layer: a typography-voice pairing table (editorial → Newsreader + Source Sans 3, ledger → Spline Sans pair, …), color-mood construction (temperature, tinted neutrals, committed accent posture, band rhythm), composition anatomy (hero formula, rows-over-card-grids, shaped whitespace), the signature element, and default-vs-directed contrast snippets. Taste rules add the named cliché clusters (the cream/terracotta "Claude look", acid-on-black, broadsheet kit, SaaS-card kit, template chrome), typography-as-personality, one-orchestrated-motion, and design-writing rules.

## The `ux_audit` tool

Deterministic slop-audit — no model needed, all gates are computable:

```
ux_audit path="web/src/app.css" pairs=[{fg:"#111",bg:"#fff",label:"body",weight:400,size:16,min:4.5}]
ux_audit css="..." pairs=[...]
```

Pass `path` to a stylesheet file — it is audited **verbatim**. Never retype or condense CSS into the `css` string when the file is on disk: retyped copies drift (inlined tokens, mislabeled pairs) and cause false gate failures or false confidence. Exactly one of `path`/`css`.

| Gate | What it checks |
|------|----------------|
| **Contrast (APCA)** | Perceptual APCA Lc per fg/bg pair (Lc ≥75 body, ≥45 large-bold, ≥30 non-text). hex or `oklch()`. Optional `weight`/`size` set the threshold. WCAG 2.x ratio shown as a compliance sidecar. |
| **Tokens** | Hardcoded hex outside `:root` token defs; `box-shadow` not built from `var(--…)` tokens |
| **States** | Interactive selectors (`button`/`a`/`input`/…/`[role=button]`) missing `:focus-visible` or `:disabled`; any transition/animation missing a `prefers-reduced-motion` fallback |
| **Slop tells** | Named AI signatures: glassmorphism (`backdrop-filter`), gradient orbs, neon glow, the shadcn default-card reflex (`rounded-2xl`+`shadow-lg`+`p-6`), 1px gray card borders, tracked-out eyebrows, tinted near-black backgrounds |

Returns pass/fail per gate + a formatted report. In `strict` mode this is the gate that blocks handoff.

**Why APCA over WCAG 2.x:** APCA is perceptual and accounts for font weight/size; it catches dark-theme + thin-type slop that the legacy WCAG ratio misses. Example: `#aaa` on `#1e1e1e` scores APCA Lc -54.4 (fails ≥75) but WCAG 7.18:1 (passes ≥4.5) — APCA catches what WCAG can't.

## Model routing (deterministic-first)

The full who-does-what table lives in the **`ux-routing`** skill (not injected — consulted when delegating). The gate is mechanical, not a vision-LLM call. **The inversion rule:** the cheaper/weaker the model, the MORE you must externalise constraints. **The deterministic-first principle:** don't spend vision-model quota on what `ux_audit` computes for free.

## Skills

- **`ux-design`** — the Constraint-First method + Direction playbook (auto-injected by the hook when active).
- **`ux-presets`** — reference presets for Step 0: neutral Web/Mobile DESIGN.md starters, three style-direction starters (S1 Editorial print, S2 Ledger, S3 Warm consumer — APCA-verified pairs), the shadcn/Material/Radix reuse table, and a CSS-only `:root` fallback. Reference only — no bundled CSS.
- **`ux-capture`** — the Step 4 render-and-inspect capture playbook: local headless-Chrome capture read inline vs daemon-rendered `web_screenshot`, LAN IP/host.docker.internal addressing, SSRF-blocked daemons, cloudflared tunnel as last resort.
- **`ux-routing`** — the model-routing table for delegating design steps (Define/Generate/Inspect/Audit) across agy/Gemini, Claude, DeepSeek, GLM, Kimi. Not injected.

## Benchmark

`bench/` holds a design-quality harness: six fixed briefs (landing, dashboard, mobile, portfolio, pricing, settings), `run.sh` (headless `pi` run with the same model + screenshot capture), and a fixed scoring rubric. Used to measure output quality across pi-ux versions; results are gitignored.

## Configuration

Environment variables (override config file):

| Variable | Default | Effect |
|----------|---------|--------|
| `PI_UX_DEFAULT_MODE` | `strict` | Default mode on startup |
| `PI_UX_QUIET_STARTUP` | unset | Suppress the startup toast |
| `PI_UX_HIDE_STATUS` | unset | Hide the status-bar indicator |

Config file: `~/.config/pi-ux/config.json` (or `$XDG_CONFIG_HOME/pi-ux/`):

```json
{ "defaultMode": "strict", "quietStartup": false, "hideStatus": false }
```

## License

MIT
