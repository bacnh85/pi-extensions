# @bacnh85/pi-plan

Pi extension that adds a lightweight plan mode inspired by Codex and Claude Code:

- Toggle plan mode with `/plan` or `Ctrl+Alt+P`.
- Remembers separate thinking/reasoning levels for planning and normal execution across sessions.
- Keeps planning safe: known read/research tools and strict read-only shell commands auto-run, unknown executables and custom tools require confirmation, direct source mutators are blocked.
- Provides a `write_plan` tool so the agent writes reviewable Markdown plans into `.agents/plans/`.
- Provides an `ask_user_question` tool for selection-style clarifying questions with an optional recommended default (★-marked) and a free-form "Other" path; works in any mode (not just plan mode).
- Prompts once after each plan is written so you can approve execution (current or fresh session) or keep planning.

## Install

```bash
pi install npm:@bacnh85/pi-plan
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
| `/handoff <goal>` | Summarize the session into a reviewable prompt and start a focused new Pi session linked to the parent. |
| `/rewind` | Select a saved prompt checkpoint and restore its code, conversation, or both. |
| `/advisor [model hint\|off]` | Configure a transcript-aware strategic advisor with `/model`-style search. |
| `/btw [query]` | Ask a context-aware side question; completed answers persist as transcript cards. Without a query, reopens the last answer. |
| `/specs <intent>` | Write a reviewable, spec-first EARS specification and hard-lock workspace writes. |
| `/specs-approve` | Release the gate and prefill the implementation instruction. |
| `/doctor` | Show compact workspace, Git, Node, model-auth, and tool health. |
| `/goal [objective\|status\|pause\|resume\|clear]` | Keep the agent working toward a verifiable condition across turns until a small-fast-model evaluator confirms it is met. |
| `/goal-model [model hint\|off]` | Configure the `/goal` evaluator model with `/model`-style search. |
| `Esc Esc` | With an empty idle editor, prefill `/rewind` in the TUI. |
| `Ctrl+Alt+P` | Toggle plan mode. |

## Workflow

1. Enter plan mode with `/plan` or `--plan`.
2. Ask pi to research the task and propose an implementation.
3. The model explores with read-only tools. Dedicated `ls`/`grep`/`find` tools and strict single read-only shell commands run automatically; test/build/package scripts and other unknown executables prompt you.
4. If decisions are ambiguous, the model can call `ask_user_question` so you can choose an option (the recommended one is ★-marked) or pick "Other" to type your own answer.
5. The model calls `write_plan` — the plan is saved under `.agents/plans/<timestamp>-<title>.md`.
6. After the plan is written, Pi prefills `/plan-approve` in the TUI. Press Enter, then choose:
   - **Implement in current session** — exits plan mode, restores tools, sends an execution prompt.
   - **Implement in new session** — starts a fresh session with the plan as handoff.
   - **Implement, verify, and review** — captures the Git baseline, implements in fresh context, invokes `pi-review` through `pi-subagent`, feeds blocking findings back as actionable issues with expected behavior and acceptance criteria, and stops clean or after three review passes.
   - **Stay in Plan mode** — continue refining the plan.

Non-blocking review findings do not enter the fix loop, but remain available in the workflow result details instead of being reported as a clean review. Automated review uses a 3-minute activity-resettable inactivity window and a 20-minute hard cap; only real reviewer progress resets the window.

`/handoff <goal>` summarizes the current session (seeded with the active plan/workflow state) into a focused, self-contained prompt, lets you review and edit it, then starts a **new Pi session** linked to the parent so the next agent can continue without the old context window. It does not carry plan mode or flow state into the new session — use `/plan-approve new|flow` to continue the same plan execution. `/rewind` captures the current Git workspace before each normal user prompt and presents the latest 100 reachable checkpoints. Select a checkpoint to restore its conversation, code, or both; code restore stashes current staged, unstaged, and untracked work, then restores the checkpoint's tracked patch (stored externally — no size limit) and untracked-file snapshot (up to 1 MB). It requires Git with unchanged `HEAD`, refuses committed divergence, and can overwrite concurrent or external changes to files restored by Pi.

Fresh-session replacement is intentionally initiated by `/plan-approve`: extension-originated messages bypass Pi's slash-command router and cannot call command-only session APIs. The automated choice requires `pi-review` and `pi-subagent`. It never resets files or Git state; initial dirty paths are recorded for reviewer context. Untracked content snapshots are lossless up to 1 MB (separate from the tracked dirty patch, which has no size limit — payloads are stored in external files under `~/.pi/agent/pi-plan/checkpoints/`) and fail closed above it. The implementer must report exact checks with `[verification: pass]` or `[verification: fail]`.

## Tool gating in plan mode

| Tool category | Behavior |
|---|---|
| Known read/research tools (built-in `read`/`ls`/`grep`/`find`, Serena, FFF, web, Munin) | Auto-allowed without prompt |
| `write_plan`, `ask_user_question` | Always available |
| `bash` (write commands: redirects, heredocs, `sed -i`, `tee`, `cp`/`mv`/`rm`, `touch`, `mkdir`) | Hard-blocked — no filesystem mutations via bash in plan mode |
| `bash` (strict single read commands: `ls`, `grep`, `find`, `git status`, `cat`) | Auto-allowed without prompt |
| `bash` (unknown executables, including test/build/package scripts) | Requires `confirm` dialog warning about possible side effects; denied without UI |
| Baseline custom tools not on the known-read list | Requires `confirm` dialog |
| Unknown tools (not in original baseline) | Requires `confirm` dialog |
| Direct source mutators (`edit`, `write`, Serena/Munin mutations) | Hard-blocked with error message |
| `multi_tool_use.parallel` | Each nested call independently gated |

## Advisor and utility command configuration

Run `/advisor` to open the same searchable picker as `/model`; type a provider/model hint to filter it. `/advisor provider/model` (or an unambiguous bare model ID) selects immediately, while an unmatched hint opens the picker prefiltered. Use `/advisor off` to disable it. The selected model persists globally in `~/.pi/agent/pi-plan/preferences.json` and is disabled by default.

When configured, the primary agent receives an `advisor` tool and decides when to use it—typically before a consequential approach, after recurring failures, or before completing non-trivial work. The advisor sees Pi's effective session transcript (including compaction summaries and tool results), returns read-only guidance to the primary agent, and does not replace `pi-review`'s Git-scoped review workflow.

Optional Pi settings (global `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`) select the `/btw` model:

```json
{
  "pi-plan": {
    "btw": { "model": "provider/model" }
  }
}
```

`/btw` injects a compact snapshot of the current session transcript as context, so it can answer questions about files read, decisions made, and things discussed earlier. It uses an isolated model call with no tool access. Completed answers render as durable transcript cards that remain visible after dismissal and are excluded from the primary agent's LLM context.

`/btw` without a query recalls the latest answer from the current session branch, including after reload or resume.

Optional Pi settings also select where plans are written (`pi-plan.plansDir`). The default is `.agents/plans` (relative to the workspace `cwd`); the `{yyyymm}` placeholder expands to the current month so plans auto-archive into monthly subfolders without any user scripts:

```json
{
  "pi-plan": {
    "plansDir": ".agents/plans/{yyyymm}"
  }
}
```

With no setting, behavior is unchanged (plans land flat in `.agents/plans/`). The resolved path is validated against the configured plans directory, so plans never escape it. `{yyyymm}` and the plan filename timestamp use the UTC month (the filename stamp is already UTC), so the monthly bucket matches the written file.

`/specs <intent>` uses an isolated model call to write one spec-first Markdown artifact under `.agents/specs/`. It includes scope, exclusions, workspace-grounded target files, EARS requirements, assumptions/open questions, and independently checkable acceptance criteria. It keeps the plan-mode write gate active until `/specs-approve` is explicitly run. Approval does not start an agent run: in the TUI it preloads an instruction to implement the approved spec and verify each criterion; non-TUI modes receive the same copyable instruction.

## Goal loop

`/goal <objective>` sets a durable condition and the agent keeps working toward it across turns without you prompting each step — a pi-native analogue of Claude Code's `/goal` and Codex's `/goal`. After each turn settles (`agent_settled`), the condition plus a compact transcript window are sent to an isolated **evaluator model** (default: the active model; configure a cheaper one with `/goal-model` or `pi-plan.goal.model`). It returns a strict-JSON `{ met, reason }` verdict:

- `met: true` → the goal clears and an achievement is recorded in the transcript.
- `met: false` → the agent takes another turn, with the reason as guidance.

Write the objective as something the agent can prove in conversation ("`npm test` exits 0", "the queue is empty", "every call site compiles"). The evaluator judges only what the agent has surfaced — it runs no tools. One goal per session/branch; setting a new one replaces the active one. `/goal` with no argument shows status (condition, turns/cap, duration, last reason); `/goal clear` (aliases `stop|off|reset|none|cancel`) stops it; `/goal pause` and `/goal resume` let you interject a manual turn without losing the goal.

A goal is an execution-time feature, so it cannot be set while plan mode or an implement→verify→review workflow is active. A hard turn cap (`pi-plan.goal.maxTurns`, default 50) stops runaway loops; include an explicit bound in the condition too (e.g. `or stop after 20 turns`). An active goal is restored on resume with its turn count and timer reset, matching Claude Code's semantics — so `maxTurns` bounds a single run segment, not cumulative turns across resumes. Optional Pi settings select the evaluator model and cap:

```json
{
  "pi-plan": {
    "goal": { "model": "provider/model", "maxTurns": 20 }
  }
}
```

## Reasoning levels and per-mode model

pi-plan remembers two configurations — one for **plan mode** and one for **normal/execution** —
and restores the right one when you toggle modes or restart the session:

- **Reasoning level.** Change Pi's active reasoning level while plan mode is active to update
  the planning level; change it in normal mode to update the execution level.
- **Model.** Change Pi's active model with `/model` (or `Ctrl+P`) while plan mode is active to
  set the planning model; change it in normal mode to set the execution model.

Both are observed automatically and persisted per model ID across sessions under your user Pi
agent directory. This makes it natural to plan with a strong model and implement with a fast
one — e.g. plan with `zai-coding-cn/glm-5.2`, then implement with `opencode-go/deepseek-v4-flash`:
the model switches automatically when you enter/leave plan mode.

Notes:
- A per-mode model is only applied when you have set one for that mode. By default (nothing
  configured), Pi's current model is left untouched when toggling modes.
- Use `/model` (or `Ctrl+P`) while in each mode — pi-plan observes and records whichever model
  you pick as that mode's preference automatically.
- Switching models persists the model as Pi's global default in `settings.json` on each change
  (Pi's own `/model` does the same). pi-plan always re-applies the correct per-mode model on
  the next mode toggle or session start.
- To clear a per-mode model, switch to your desired default while in that mode, or edit the
  `planModel`/`normalModel` fields out of `~/.pi/agent/pi-plan/preferences.json`.
- If the configured model isn't loaded yet (e.g. a provider like 9router that registers models
  asynchronously), the switch is deferred and retried the moment the provider announces its models.
  If the model is genuinely unavailable (no API key or not found), the switch is skipped with a
  warning and the current model is kept.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Packaging

This is a Pi package. Runtime imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies.
