---
name: agy-delegate
description: >
  Delegate bulk implementation, scaffolding, repetitive refactors, and
  exhaustive test generation to the Antigravity CLI (agy).
argument-hint: "prompt=\"...\" [model=flash-low|flash-medium|flash-high|pro-low|pro-high|sonnet|opus|gpt-oss] [mode=plan|accept-edits|sandbox]"
license: MIT
---

# agy-delegate

Use the `agy_execute` tool to offload large scaffolding, repetitive refactors,
or exhaustive test generation via the Antigravity CLI.

## Prerequisites

1. Install the Antigravity CLI (a Go binary, not pipx):

   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ````

2. Authenticate in a terminal (one-time):

   ```bash
   agy
   ```

3. Verify the CLI works:

   ```bash
   agy --version
   agy models
   ```

## Tool usage

```
agy_execute prompt="Refactor all snake_case variables to camelCase in src/models/"
agy_execute prompt="Generate exhaustive unit tests for src/auth/" model=flash-low
agy_execute prompt="Plan the migration to ESM" model=sonnet mode=plan digest=true
```

## Modes

| Mode | Purpose |
|------|---------|
| `plan` | Exploration and planning — no edits |
| `accept-edits` (default) | Implementation — agy applies edits directly |
| `sandbox` | Preview changes without applying |

## Rules

- **Always review the `git diff`** after agy runs with `accept-edits`.
- **Never use agy for irreversible production changes.**
- Use `flash-medium` by default, `flash-low` for trivial/high-volume work, and `flash-high` for difficult agentic work.
- Escalate within the Gemini quota group to `pro-low` or `pro-high` only when needed.
- Use `sonnet` for normal Claude-group coding/review; reserve `opus` for the hardest architecture or root-cause work.
- Use `gpt-oss` when an open-model alternative is specifically desired.
- For consequential work, have one family produce and the opposite family review with `mode=plan`; do not spend both groups on trivial tasks.
- Batch related work, avoid parallel calls within one shared-quota group, and use `digest=true` (default) for non-write tasks.
- Legacy `tier=flash|flash-lo|pro` remains supported, but `model` takes precedence.

## How pi-agy controls the handoff

Pi delegates to agy as a **producer**, not an autonomous agent. Each call is
framed for verifiability and parseability:

- **`plan`** is read-only; returns parsed JSON (the `.response` field).
- **`accept-edits`** and **`sandbox`** both write, so pi-agy passes
  `--dangerously-skip-permissions` (headless `-p` auto-denies writes without
  it). In `accept-edits`, if the project has a `test` script, pi-agy appends a
  verify-loop instruction (`run \`npm test\` and fix failures`).
- **`sandbox`** also returns parsed JSON.
- Model aliases map to agy's canonical machine names; run `agy models` if
  Antigravity renames them.
