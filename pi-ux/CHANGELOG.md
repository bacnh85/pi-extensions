# Changelog

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
