# pi-plan

Pi extension that adds a lightweight plan mode inspired by Codex and Claude Code:

- Toggle plan mode with `/plan` or `Ctrl+Alt+P`.
- Remembers separate thinking/reasoning levels for planning and normal execution across sessions.
- Keeps planning safe: known read/research tools auto-run, all bash requires confirmation, unknown or custom tools require confirmation, direct source mutators are blocked.
- Provides a `write_plan` tool so the agent writes reviewable Markdown plans into `.agents/plans/`.
- Provides an `ask_plan_question` tool for selection-style clarifying questions during planning.
- Prompts once after each plan is written so you can approve execution (current or fresh session) or keep planning.

## Install

```bash
pi install npm:@bacnh85/pi-plan
```

From a local checkout:

```bash
pi install ./pi-plan
```

Start directly in planning mode:

```bash
pi --plan
```

## Commands and shortcuts

| Command / shortcut | Description |
| --- | --- |
| `/plan` | Toggle plan mode. |
| `Ctrl+Alt+P` | Toggle plan mode. |

## Workflow

1. Enter plan mode with `/plan` or `--plan`.
2. Ask pi to research the task and propose an implementation.
3. The model explores with read-only tools. Bash requires your confirmation; known read/research tools (Serena, FFF, web, Munin) run automatically; other tools prompt you.
4. If decisions are ambiguous, the model can call `ask_plan_question` so you can choose or type your own answer.
5. The model calls `write_plan` — the plan is saved under `.agents/plans/<timestamp>-<title>.md`.
6. After the plan is written, you'll see three choices:
   - **Implement in current session** — exits plan mode, restores tools, sends an execution prompt.
   - **Implement in new session** — exits plan mode and starts a fresh session with the plan as handoff.
   - **Stay in Plan mode** — continue refining the plan.

## Tool gating in plan mode

| Tool category | Behavior |
|---|---|
| Known read/research tools (Serena, FFF, web, Munin) | Auto-allowed without prompt |
| `write_plan`, `ask_plan_question` | Always available |
| `bash` | Requires `confirm` dialog; denied without UI |
| Baseline custom tools not on the known-read list | Requires `confirm` dialog |
| Unknown tools (not in original baseline) | Requires `confirm` dialog |
| Direct source mutators (`edit`, `write`, Serena/Munin mutations) | Hard-blocked with error message |
| `multi_tool_use.parallel` | Each nested call independently gated |

## Reasoning levels

pi-plan remembers two reasoning levels:

- Change Pi's active reasoning level while plan mode is active to update the planning level.
- Change Pi's active reasoning level in normal mode to update the normal/execution level.

Levels are persisted per model ID across sessions under your user Pi agent directory.

## Packaging

This is a Pi package. Runtime imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies.
