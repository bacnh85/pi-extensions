# pi-plan

Pi extension that adds a lightweight plan mode inspired by Codex and Claude Code:

- Toggle plan mode with `/plan` or `Ctrl+Alt+P`.
- Remembers separate thinking/reasoning levels for planning and normal execution across sessions.
- Keeps planning safe: known read/research tools and strict read-only shell commands auto-run, unknown executables and custom tools require confirmation, direct source mutators are blocked.
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
| `/plan-approve [current|new|flow]` | Open approval choices or execute a specific handoff through Pi's command router. |
| `/flow status` | Show the active workflow phase and review pass. |
| `/flow stop` | Abort review and stop the active workflow. |
| `Ctrl+Alt+P` | Toggle plan mode. |

## Workflow

1. Enter plan mode with `/plan` or `--plan`.
2. Ask pi to research the task and propose an implementation.
3. The model explores with read-only tools. Dedicated `ls`/`grep`/`find` tools and strict single read-only shell commands run automatically; test/build/package scripts and other unknown executables prompt you.
4. If decisions are ambiguous, the model can call `ask_plan_question` so you can choose or type your own answer.
5. The model calls `write_plan` — the plan is saved under `.agents/plans/<timestamp>-<title>.md`.
6. After the plan is written, Pi prefills `/plan-approve` in the TUI. Press Enter, then choose:
   - **Implement in current session** — exits plan mode, restores tools, sends an execution prompt.
   - **Implement in new session** — starts a fresh session with the plan as handoff.
   - **Implement, verify, and review** — captures the Git baseline, implements in fresh context, invokes `pi-review` through `pi-subagent`, feeds blocking findings back as actionable issues with expected behavior and acceptance criteria, and stops clean or after three review passes.
   - **Stay in Plan mode** — continue refining the plan.

Non-blocking review findings do not enter the fix loop, but remain available in the workflow result details instead of being reported as a clean review. Automated review uses a 3-minute activity-resettable inactivity window and a 20-minute hard cap; only real reviewer progress resets the window.

Fresh-session replacement is intentionally initiated by `/plan-approve`: extension-originated messages bypass Pi's slash-command router and cannot call command-only session APIs. The automated choice requires `pi-review` and `pi-subagent`. It never resets files or Git state; initial dirty paths are recorded for reviewer context. Untracked content snapshots are lossless up to the same 50 KB evidence limit as tracked dirty patches and fail closed above it. The implementer must report exact checks with `[verification: pass]` or `[verification: fail]`.

## Tool gating in plan mode

| Tool category | Behavior |
|---|---|
| Known read/research tools (built-in `read`/`ls`/`grep`/`find`, Serena, FFF, web, Munin) | Auto-allowed without prompt |
| `write_plan`, `ask_plan_question` | Always available |
| `bash` (write commands: redirects, heredocs, `sed -i`, `tee`, `cp`/`mv`/`rm`, `touch`, `mkdir`) | Hard-blocked — no filesystem mutations via bash in plan mode |
| `bash` (strict single read commands: `ls`, `grep`, `find`, `git status`, `cat`) | Auto-allowed without prompt |
| `bash` (unknown executables, including test/build/package scripts) | Requires `confirm` dialog warning about possible side effects; denied without UI |
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
