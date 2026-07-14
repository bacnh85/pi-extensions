---
name: agy-delegate
description: >
  Delegate bulk implementation, scaffolding, repetitive refactors, and
  exhaustive test generation to the Antigravity CLI (agy).
argument-hint: "prompt=\"...\" [tier=flash|flash-lo|pro] [mode=plan|accept-edits|sandbox]"
license: MIT
---

# agy-delegate

Use the `agy_execute` tool to offload large scaffolding, repetitive refactors,
or exhaustive test generation via the Antigravity CLI.

## Prerequisites

1. Install the Antigravity CLI:

   ```bash
   pipx install antigravity
   ```

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
agy_execute prompt="Generate exhaustive unit tests for src/auth/" tier=flash-lo
agy_execute prompt="Plan the migration to ESM" mode=plan digest=true
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
- Start with `mode=plan` for exploration, then switch to `accept-edits` for the actual implementation.
- Use `tier=flash-lo` for repetitive boilerplate; use `tier=pro` for complex logic.
- Set `digest=true` (default) for non-write tasks to keep output compact.
