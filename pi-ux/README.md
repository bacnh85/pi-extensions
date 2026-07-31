# pi-ux

Anti-slop UI/UX design discipline for the [Pi coding agent](https://pi.dev). Enforces industrial-design principles (Dieter Rams: honest, thorough to the last detail, as little design as possible) so AI-generated interfaces are defensible systems, not statistical-default slop (purple glow, shadow-as-texture, missing states).

This is a **discipline enforcer**, not a generator. Generation stays with `agy_execute` (Gemini/Claude) and the main Pi models (DeepSeek-v4, GLM-5.2); pi-ux makes sure their output lands inside a defensible design system.

## Why

AI-generated UI converges on the same defaults — purple/indigo glow, shadow-heavy cards, missing focus/disabled/error states — because under vague direction ("make it modern/clean"), models reach for high-frequency statistical patterns. Slop is an **ownership problem**: "the design has no owner at the system level." A skill alone is ignorable; a `before_agent_start` hook is not.

## Install

```bash
npm install @bacnh85/pi-ux
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

0. **Own the system** — tokens (colour/type/spacing/radius), 3–5 named elevation levels, state contract. If absent, no generation yet — use the `ux-presets` skill to reuse shadcn/ui, Material, or Radix, or copy a compact token set.
1. **5-field brief per screen** — user job, inventory, token constraints, required states, one reference.
2. **Generate fast, converge early** — 2-loop convergence trigger, else tighten the brief.
3. **Normalise** the draft back into tokens/elevation/spacing.
4. **Slop-audit gate** — run `ux_audit` (measurable): token coverage ≥8/10, ≤3 shadow recipes, WCAG AA contrast, full state coverage.

## The `ux_audit` tool

Deterministic slop-audit — no model needed, all gates are computable:

```
ux_audit css="..." pairs=[{fg:"#111",bg:"#fff",label:"body",min:4.5}]
```

| Gate | What it checks |
|------|----------------|
| **Contrast** | WCAG 2.x relative-luminance ratio for each fg/bg pair (4.5:1 body, 3:1 large/UI) |
| **Tokens** | Hardcoded hex outside `:root` token defs; `box-shadow` not built from `var(--…)` tokens |
| **States** | Interactive selectors (`button`/`a`/`input`/…/`[role=button]`) missing `:focus-visible` or `:disabled` |

Returns pass/fail per gate + a formatted report. In `strict` mode this is the gate that blocks handoff.

## Skills

- **`ux-design`** — the Constraint-First method + model routing (auto-injected by the hook when active).
- **`ux-presets`** — reference design-system presets for Step 0: reuse shadcn/ui / Material 3 / Radix, or copy a compact token set. Reference only — no bundled CSS.

The skill tells the agent which model to use for each step:

| Step | Best tool/model |
|------|-----------------|
| Define system (tokens, elevation) | `agy_execute mode=plan pro-high` (Gemini) or reuse shadcn/Material |
| Per-screen brief | **GLM-5.2** (200K ctx) |
| Generate variants | `agy_execute mode=accept-edits flash-high` (Gemini) |
| Normalise into system | **DeepSeek-v4** or **GLM-5.2** |
| Slop audit | `ux_audit` tool (deterministic) |
| Final review/polish | `agy_execute mode=plan sonnet` (Claude) |

**The inversion rule:** the cheaper/weaker the model, the MORE you must externalise constraints. DeepSeek/GLM are safe for design only inside a fully-specified system.

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
