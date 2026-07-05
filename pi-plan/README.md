# pi-plan

Pi extension that adds a lightweight plan mode inspired by Codex and Claude Code:

- Toggle plan mode with `/plan` or `Ctrl+Alt+P`.
- Remembers separate thinking/reasoning levels for planning and normal execution across sessions based on the active mode when you change Pi's reasoning level.
- Keeps planning read-only by limiting active tools to planning-safe tools and blocking destructive shell commands.
- Provides a `write_plan` tool so the agent writes reviewable Markdown plans into `.agents/plans/` in the current workspace.
- Provides an `ask_plan_question` tool so the agent can ask selection-style clarifying questions during planning, with an option for free-form user input.
- Prompts after a plan is written so you can approve execution, approve only, keep planning, or refine with feedback.

## Install

From npm after the package is published:

```bash
pi install npm:@bacnh85/pi-plan
```

From this repository checkout:

```bash
pi install ./pi-plan
```

For local development without installing:

```bash
pi -e ./pi-plan
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

1. Enter plan mode.
2. Ask pi to research the task and propose an implementation.
3. The model explores read-only context. If a consequential decision remains ambiguous, it can call `ask_plan_question` so you can choose an option or type your own answer.
4. The model calls `write_plan`.
5. The plan is saved under `.agents/plans/<timestamp>-<title>.md`.
6. Choose one of the approval options:
   - **Execute in current session**: exits plan mode, restores tools, applies normal thinking level, shows current context usage in the option label, and sends a follow-up execution prompt.
   - **Execute in new session**: exits plan mode and prepares a fresh session that uses the saved Markdown plan file as the handoff artifact.
   - **Approve only**: exits plan mode without starting work.
   - **Keep planning**: remains in plan mode.
   - **Refine with feedback**: sends your feedback as a follow-up planning prompt.

Agents should ask blocking, user-answerable planning questions with `ask_plan_question` before finalizing a plan. Final plans may still list non-blocking uncertainties or implementation-time checks, but should not leave consequential user decisions unresolved.

## Plan-mode bash allowlist

Plan mode allows only a narrow read-only subset of shell commands. Examples include:

```bash
git status --short
git diff
git show HEAD -- package.json
git log --oneline -5
git branch --show-current
git rev-parse --show-toplevel
npm view <package> --json
npm info <package> version
npm pack <package> --dry-run --json --ignore-scripts
```

`npm view` and `npm info` are allowed only for npm registry metadata lookup. `npm pack` is allowed only with both `--dry-run` and `--ignore-scripts` for package-content inspection. These commands may contact the network and disclose the queried package name, but pi-plan does not allow npm install/update/publish/run/exec/auth/config style commands in plan mode.

## Reasoning levels

pi-plan remembers two reasoning levels:

- Change Pi's active reasoning level while plan mode is active to update the planning level.
- Change Pi's active reasoning level in normal or execution mode to update the normal/execution level.

The remembered levels are restored when switching modes and across independent or resumed sessions. pi-plan stores only these non-sensitive preferences under your user Pi agent directory.

## Design notes

Research findings used for this extension:

- Pi has no built-in plan mode by design, but extensions can implement it with commands, shortcuts, tools, tool gating, and prompt injection.
- Claude Code plan mode emphasizes read-only exploration, writing a Markdown plan, and an approval flow before edits.
- Codex guidance recommends plan mode for complex or ambiguous tasks and using higher reasoning levels for harder planning/debugging work.

This extension deliberately writes visible workspace plans instead of hidden internal state so you can review, edit, commit, or discard them like any other project artifact.

## Packaging and release

`package.json` declares this as a Pi package with the `pi-package` keyword and a `pi.extensions` entry for `./extensions/index.ts`. Runtime Pi imports are listed as peer dependencies per Pi package guidance.

The repository publish workflow includes `pi-plan`. Bump the package version in `package.json` when publishing a new npm release; the CI workflow only publishes packages whose versions changed.
