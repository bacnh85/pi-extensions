# Agent Definition Format

Sub-agents are defined as Markdown files with YAML frontmatter.

## File Location

| Location | Scope |
|----------|-------|
| `~/.pi/agent/agents/*.md` | User-level (all projects) |
| `.pi/agents/*.md` | Project-level |
| `<package>/agents/*.md` | Bundled with pi-subagent |

Project agents override user agents with the same name when `agentScope: "both"`.

## Frontmatter Fields

```yaml
---
name: my-agent          # Required. Unique identifier (kebab-case).
description: ...        # Required. When to use this agent.
tools: read, grep, ...    # Optional. Comma-separated tool names. Defaults to all.
model: "@fast"           # Optional. Role alias (quoted — @ is YAML-reserved) or provider/model.
models:                   # Optional ordered fallbacks; comma form also accepted.
  - "@fast"
  - provider/backup-model
thinking: low             # Optional: off|minimal|low|medium|high|xhigh|max.
sandbox: read-only        # Optional: read-only | workspace-write | worktree. Auto-derives tool restrictions.
color: cyan               # Optional: red|blue|green|yellow|purple|orange|pink|cyan.
timeout: 10               # Optional: per-agent inactivity timeout in minutes (1–60). Default 3. For slow-thinking (thinking: high) agents.
---
```

### Model roles

`model`/`models` entries may reference *roles* instead of concrete models:
`"@fast"`, `"@coder"`, `"@smart"`, or any role defined under
`subagent.roles` in `~/.pi/agent/settings.json`. A role expands to an ordered
fallback chain (string with commas, or array). `"*"` / `"@default"` mean
"use the parent model". A trailing `:level` (`"@smart:high"`) overrides the
agent's `thinking` for that match. See README → *Role-based model routing*.

### `sandbox`

- `read-only`: Restricts tools to the read-only allowlist (`read`, `grep`, `find`, `ls` plus read-only extension tools when inherited — `web_*`, `serena_*`, `munin_*`, `fff*`, …). Overrides any `tools` field.
- `workspace-write` (default): Uses the agent's `tools` list or defaults to all tools.
- `worktree`: Runs the agent in an isolated git worktree (`.pi-worktrees/<id>` under the repo root). All file mutations land in the worktree; the main checkout is untouched. On completion, the unified diff is delivered in the tool result as a `🌿 worktree patch` block; pass `merge: "3way"` to apply it to the parent checkout automatically (`git apply --3way`, conflicts reported as `mergeStatus: "conflict"` with markers left in place). Falls back to in-process execution when the cwd is not a git repo (with a warning). Requires git.

### `color`

Display color for the agent name in the TUI thread picker, viewer, and result summary.
Accepted values: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`.

Only `name` and `description` are required.

## Body

The body after frontmatter becomes the agent's **entire system prompt**. No pi defaults, no AGENTS.md files, no skills — only what you write here. Keep it focused.

## Available Tools

Child agent tools are validated against a fixed allowlist:

| Category | Tools |
|----------|-------|
| Read-only | `read`, `grep`, `find`, `ls` |
| Mutation | `edit`, `write` |
| Execution | `bash` |

The `subagent` tool is always rejected to prevent recursive delegation.
Unknown or misspelled tool names produce a clear error.
Duplicate names are deduplicated automatically.

**Tool inheritance:** an agent WITHOUT an explicit `tools:` line inherits every
tool the parent session has (minus `subagent`), including extension tools like
`web_search`, `serena_*`, `munin_*`, `obsidian`, and `notebooklm`, and runs with
the parent's extensions loaded. An agent WITH an explicit `tools:` list is
validated against built-ins ∪ the inherited set and, when the list contains
only built-ins, runs in a lean loader with no extensions/skills loaded. To
force an inheriting agent lean, set `tools: read, bash, edit, write, grep, find, ls`.

Read-only service execution (used by `pi-review`) restricts tools to the
read-only allowlist (including read-only extension tools when inherited).

## Model Resolution

Pi selects the first authenticated/configured model reported by the parent session's `ModelRegistry`. Resolution order is legacy `model`, then each `models` entry, then the authenticated parent model. Duplicate candidates are ignored. If no candidate is available, the error lists every attempted model.

```yaml
models:
  - zai-coding-cn/glm-5.2
  - opencode-go/deepseek-v4-flash
  - nvidia/moonshotai/kimi-k2.6
```

The registry includes OAuth subscriptions, API-key subscriptions such as OpenCode Go, environment/runtime credentials, and custom `models.json` providers. Use provider-qualified IDs for predictable routing.

## Instruction handoff

Children do not automatically load repository instructions. Callers may pass an `instructions` task contract, truncated to 16 KB. Use this for relevant repository rules or review contracts rather than copying the parent transcript.

## Token Budget

Each sub-agent runs with:
- **System prompt**: agent body only (~200-1K tokens typical)
- **No AGENTS.md**: saves 500-5K tokens
- **No extensions/skills loaded**: saves 200-1K tokens — but only for agents whose effective tool set is built-in only (explicit `tools:` line). Agents that inherit parent tools load the parent's extensions into the child (higher token cost, full toolset).
- **Thinking per role**: defaults off; bundled scout/reviewer/worker choose low/high/medium
- **No compaction**: avoids compaction token cost

This is ~10x leaner than spawning a full `pi` process.
