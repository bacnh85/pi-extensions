# pi-ux

Anti-slop UI/UX design discipline for the [Pi coding agent](https://pi.dev). Anchors a lintable **DESIGN.md**, runs **deterministic** slop-audit gates (APCA contrast + tokens + states + slop tells), and works **with text-only models** (DeepSeek-v4, GLM-5.2, Kimi K3) — `agy`/Gemini/Claude is optional polish, never the review gate.

## Why

AI-generated UI converges on the same defaults — purple/indigo glow, shadow-heavy cards, missing focus/disabled/error states — because under vague direction, models reach for high-frequency statistical patterns. Slop is an **ownership problem**: "the design has no owner at the system level." The fix is shift-left: own the system in a DESIGN.md, then gate deterministically.

**Text-only models now lead frontend** (Kimi K3, an open MIT model, is #1 on the Arena.ai Frontend Code Arena, ahead of Claude Fable 5). Inside a fully-specified system they produce non-slop UI — which means the review gate can be mechanical, not a vision-LLM call.

## Install

```bash
pi install npm:@bacnh85/pi-ux
```

Pi auto-discovers the extension and skill.

## Usage

```
/ux              # toggle / show status
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
   If absent, reuse a preset (`ux-presets` skill: shadcn/Material/Radix) or scaffold one once. pi-ux orchestrates `@google/design.md` via shell-out — **not** a runtime dependency.
1. **5-field brief per screen** — user job, inventory, token constraints, required states, one reference.
2. **Generate fast, converge early** — text-only models inside the locked system; 2-loop convergence trigger.
3. **Normalise** the draft back into tokens/elevation/spacing.
4. **Slop-audit gate** — run `ux_audit` (measurable): APCA contrast, token coverage, state coverage, slop tells.

## The `ux_audit` tool

Deterministic slop-audit — no model needed, all gates are computable:

```
ux_audit css="..." pairs=[{fg:"#111",bg:"#fff",label:"body",weight:400,size:16,min:4.5}]
```

| Gate | What it checks |
|------|----------------|
| **Contrast (APCA)** | Perceptual APCA Lc per fg/bg pair (Lc ≥75 body, ≥45 large-bold, ≥30 non-text). hex or `oklch()`. Optional `weight`/`size` set the threshold. WCAG 2.x ratio shown as a compliance sidecar. |
| **Tokens** | Hardcoded hex outside `:root` token defs; `box-shadow` not built from `var(--…)` tokens |
| **States** | Interactive selectors (`button`/`a`/`input`/…/`[role=button]`) missing `:focus-visible` or `:disabled` |
| **Slop tells** | Named AI signatures: glassmorphism (`backdrop-filter`), gradient orbs, neon glow, the shadcn default-card reflex (`rounded-2xl`+`shadow-lg`+`p-6`), 1px gray card borders |

Returns pass/fail per gate + a formatted report. In `strict` mode this is the gate that blocks handoff.

**Why APCA over WCAG 2.x:** APCA is perceptual and accounts for font weight/size; it catches dark-theme + thin-type slop that the legacy WCAG ratio misses. Example: `#aaa` on `#1e1e1e` scores APCA Lc -54.4 (fails ≥75) but WCAG 7.18:1 (passes ≥4.5) — APCA catches what WCAG can't.

## Model routing (deterministic-first)

The skill tells the agent which model to use for each step. The gate is mechanical, not a vision-LLM call:

| Step | Best tool/model |
|------|-----------------|
| Define system (DESIGN.md) | Reuse a preset OR `agy_execute mode=plan pro-high` (Gemini) **once** |
| Lint system | `npx @google/design.md lint DESIGN.md` (shell-out) |
| Per-screen brief | **GLM-5.2** (1M ctx) |
| Generate variants | **DeepSeek-v4**, **GLM-5.2**, or **Kimi K3** (text-only, inside constraints) |
| Normalise into system | **DeepSeek-v4** or **GLM-5.2** |
| Slop audit | `ux_audit` tool (deterministic) + DESIGN.md lint |
| Optional polish (never a gate) | `agy_execute mode=accept-edits sonnet` (Claude) |

**The inversion rule:** the cheaper/weaker the model, the MORE you must externalise constraints. **The deterministic-first principle:** don't spend vision-model quota on what `ux_audit` computes for free.

## Skills

- **`ux-design`** — the Constraint-First method + deterministic-first model routing (auto-injected by the hook when active).
- **`ux-presets`** — reference design-system presets for Step 0: a lintable DESIGN.md starter, the shadcn/Material/Radix reuse table, and a CSS-only `:root` fallback. Reference only — no bundled CSS.

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
