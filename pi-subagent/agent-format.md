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
tools: read, grep, ...  # Optional. Comma-separated tool names. Defaults to all.
model: provider/model     # Optional. Defaults to parent's model.
thinking: low             # Optional: off|minimal|low|medium|high|xhigh|max.
---
```

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

Custom/extension tools are NOT available to sub-agents by default (each runs in an isolated in-memory session with no extensions).

Read-only service execution (used by `pi-review`) restricts tools to the read-only category.

## Model Resolution

Model IDs are resolved via `getModel("provider", "id")`. Common values:
- `claude-haiku-4-5` (Anthropic Haiku — fast, cheap)
- `claude-sonnet-4-20250514` (Anthropic Sonnet — balanced)
- `gpt-4o` (OpenAI)
- Any model available in your pi configuration.

If not specified, defaults to the parent session's model.

## Instruction handoff

Children do not automatically load repository instructions. Callers may pass an `instructions` task contract, truncated to 16 KB. Use this for relevant repository rules or review contracts rather than copying the parent transcript.

## Token Budget

Each sub-agent runs with:
- **System prompt**: agent body only (~200-1K tokens typical)
- **No AGENTS.md**: saves 500-5K tokens
- **No extensions/skills loaded**: saves 200-1K tokens
- **Thinking per role**: defaults off; bundled scout/reviewer/worker choose low/high/medium
- **No compaction**: avoids compaction token cost

This is ~10x leaner than spawning a full `pi` process.
