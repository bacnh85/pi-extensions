---
name: ux-routing
description: >
  Reference table for dividing UX work across models in the Pi ecosystem —
  who defines the DESIGN.md scaffold, who generates variants, who renders and
  inspects, what reviews. Consult when delegating design work to other models
  (agy/Gemini, Claude, DeepSeek, Kimi) or when deciding whether the main model
  should do a step itself. Not injected into every turn by design; the
  always-true core rule lives in ux-design: the deterministic gate reviews, a
  multimodal model looks at its own render, and taste lives in the direction
  brief, not in the model choice.
---

# Model routing for design work (who does what)

Split the work along each model's strength. **The inversion rule:** the
cheaper/weaker the model, the MORE you must externalise constraints. Taste
lives in the direction brief, not the weights.

**The deterministic-first principle:** the gate is mechanical (DESIGN.md lint +
`ux_audit`), not a vision-LLM call. Text-only models now lead frontend
(Kimi K3 is #1 on the Arena.ai Frontend Code Arena, ahead of Claude Fable 5) —
inside a locked system they produce non-slop. agy/Gemini/Claude is optional,
never the review gate.

| Step | Best tool/model | Why |
|---|---|---|
| **Define system** (DESIGN.md: tokens, elevation, type) | Reuse a preset (ux-presets) OR `agy_execute mode=plan pro-high` (Gemini) **once** | Preset is cheapest. Gemini = strongest visual reasoning for the one-time scaffold. |
| **Derive direction** (Step 1.5) | The generating model itself, after reading the subject material | Direction needs the subject brief, not a bigger model. |
| **Lint system** | `npx @google/design.md lint DESIGN.md` (shell-out) | Deterministic token-ref + contrast + structure validation. |
| **Per-screen brief** | Main Pi model: **GLM-5.2** | 1M ctx holds the whole DESIGN.md while scoping one screen |
| **Generate variants** | Main Pi model: **DeepSeek-v4**, **GLM-5.2**, or **Kimi K3** | Text-only models lead frontend inside a locked system; cheaper than vision calls. |
| **Normalise into system** | Main Pi model: **DeepSeek-v4** or **GLM-5.2** | Long context, token remapping, mechanical precision |
| **Render & inspect** | The generating model itself, when multimodal (GLM-5.3, Claude, Gemini) via `web_screenshot` | Eyes on your own output beat rules in a prompt — flash-tier models produce notably better UI when they see the rendered result (inline image blocks) |
| **Slop audit** | `ux_audit` tool (deterministic) + DESIGN.md lint | Contrast (APCA) + tokens + states + slop tells are computable, not judgement |
| **Optional polish** (never a gate) | `agy_execute mode=accept-edits sonnet` (Claude) or `opus` | Only if brand-fit is uncertain after the deterministic gate passes. NOT required. |

**Cross-family rule:** Gemini/Claude produce → deterministic gate reviews. Don't
spend vision-model quota on what `ux_audit` computes for free. agy review is a
fallback for aesthetic uncertainty, never the gate.

DeepSeek/GLM/Kimi K3 are safe for design **only inside a fully-specified
system** (DESIGN.md or preset + direction brief). If no system exists yet,
create it once (preset + Step 1.5 direction, or agy), then text-only models
are sufficient for every generation thereafter.
