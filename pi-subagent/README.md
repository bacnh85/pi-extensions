# @bacnh85/pi-subagent

Isolated in-process subagents for Pi. The `subagent` tool supports single, parallel (8 tasks, 4 concurrent), and chained execution; `/agent` opens inspectable child threads.

## Install

```bash
pi install npm:@bacnh85/pi-subagent
```

Requires Node.js >= 20.18.

## Bundled roles

| Role | Ordered model preferences | Thinking | Tools |
| --- | --- | --- | --- |
| `scout` | `zai-coding-cn/glm-5-turbo` → `nvidia/openai/gpt-oss-20b` → `opencode-go/deepseek-v4-flash` | off | read, grep, find, ls |
| `tester` | `zai-coding-cn/glm-5-turbo` → `nvidia/openai/gpt-oss-20b` → `opencode-go/deepseek-v4-flash` | off | read, bash, grep, find, ls |
| `worker` | `zai-coding-cn/glm-5.1` → `nvidia/mistralai/mistral-small-4-119b-2603` → `openrouter/nvidia/nemotron-3-super-120b-a12b:free` → `opencode-go/deepseek-v4-flash` | medium | read, bash, edit, write, grep, find, ls |
| `general-purpose` | `zai-coding-cn/glm-5.1` → `nvidia/mistralai/mistral-small-4-119b-2603` → `openrouter/nvidia/nemotron-3-super-120b-a12b:free` → `opencode-go/deepseek-v4-flash` | medium | read, bash, edit, write, grep, find, ls |
| `planner` | `zai-coding-cn/glm-5.2` → `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` → `opencode-go/deepseek-v4-pro` | high | read, grep, find, ls |
| `reviewer` | `zai-coding-cn/glm-5.2` → `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` → `opencode-go/deepseek-v4-pro` | high | read, grep, find, ls |

Each role uses the first authenticated preference available through Pi's model registry, then falls back to the authenticated parent model. Chains are **free-first** to conserve the metered opencode-go budget: **zai-coding-cn** (free GLM, primary) → free **nvidia** NIM and **openrouter** `:free` models → **opencode-go** (paid DeepSeek, last resort — one per role: `deepseek-v4-flash` for fast/strong-coding, `deepseek-v4-pro` for deep reasoning). opencode-go's GLM models cost ~$1.40/$4.40 per M versus zai-coding-cn's free GLM, so GLM stays on zai-coding-cn. Fallback models were live-verified on 2026-07-24; `nvidia/moonshotai/kimi-k2.6` and `nvidia/z-ai/glm-5.2` return 404/timeout on the user's account and were removed — non-rate-limit failures kill the subagent instead of advancing the chain. User/project agent files remain stronger overrides and may set legacy `model`, ordered `models`, and `thinking`.

## Agent files

Create `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`:

```markdown
---
name: scout-fast
description: Locate relevant files and symbols
tools: read, grep, find, ls
models:
  - zai-coding-cn/glm-5-turbo
  - nvidia/openai/gpt-oss-20b
  - opencode-go/deepseek-v4-flash
---

Return concise evidence with file/symbol anchors.
```

Agent definitions are cached with file-signature invalidation; `/subagent reload` clears the cache.

## Context and limits

Children use in-memory SDK sessions with no extensions, skills, prompt templates, or automatic `AGENTS.md` loading. The optional `instructions` argument passes a bounded 16 KB task/repository contract. Only Pi built-in tools are available; Serena, FFF, web, and Munin are not available in lean children.

Threads are session-memory only and are cleared when Pi replaces or reloads the session. Timeout and parent cancellation propagate to child sessions. Subagents cannot recursively invoke `subagent`.

## Security model

### Project-local agents

Agent files under `.pi/agents/` are controlled by the current repository. A project agent's system prompt may instruct a child to execute shell commands or modify files.

- **Project-agent approval cannot be disabled by the model.** The `confirmProjectAgents` parameter is not exposed in the tool schema. Confirmation policy comes from trusted user configuration only.
- **Interactive sessions** prompt the user before executing project agents.
- **Headless sessions fail closed.** Project agents are not executed without UI confirmation unless the trusted setting `allowUnconfirmedProjectAgents` is enabled (via `PI_SUBAGENT_ALLOW_UNCONFIRMED_PROJECT_AGENTS=true` environment variable or pi settings).
- **The extension service path** (`pi-subagent:run` event) follows the same policy.

### Child working directories

Child working directories are restricted to the parent session's workspace by default:

- Relative paths are resolved within the workspace.
- `..` traversal that escapes the workspace is rejected.
- Absolute paths outside the workspace are rejected.
- Symlinks are resolved via realpath; symlink escapes are rejected.
- Non-existent directories and file paths are rejected.

The trusted setting `allowExternalCwd` (via `PI_SUBAGENT_ALLOW_EXTERNAL_CWD=true` env or pi settings) can opt out. This setting cannot be enabled by the model.

### Tool validation

Child agent tools are validated against a fixed allowlist:

- **Allowed:** `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`
- **Always rejected:** `subagent` (prevents recursive delegation)
- **Read-only restriction:** When a service requests read-only execution, only `read`, `grep`, `find`, `ls` are permitted. `bash`, `edit`, and `write` are rejected.

Unknown or misspelled tool names produce clear diagnostics. Duplicate tool names are deduplicated.

### Timeouts

Every child execution receives a timeout:

- **Default inactivity window:** 3 minutes (`DEFAULT_TIMEOUT_MS`); real SDK lifecycle activity resets it.
- **Absolute cap:** 20 minutes for every child, even when active.
- **Maximum requested inactivity window:** 60 minutes (`MAX_TIMEOUT_MS`); values must be positive integers.
- Timeout diagnostics distinguish `Idle timeout` from `Hard timeout` and parent cancellation.
- 30-second progress heartbeats only keep the parent transport alive; they never reset inactivity.
- `/agent` shows last real activity and the remaining idle window; parallel tasks and chain steps may have per-item windows.

### Output safety

Child output is untrusted data and may contain prompt injection. Treat child results as model-generated content, not as verified facts.

### Cost awareness

Parallel delegation may multiply provider usage and cost. Each parallel task runs as a separate SDK session with its own token consumption.

### Agent file review

User and project agent files should be reviewed before use. Malformed files produce diagnostics but do not prevent valid agents from loading.

## Modes

### Single mode

```ts
subagent({ agent: "scout", task: "Find auth-related files" })
```

### Parallel mode

```ts
subagent({
  tasks: [
    { agent: "scout", task: "Find API routes" },
    { agent: "scout", task: "Find database models" },
    { agent: "scout", task: "Find test files" },
  ],
  abortOnFailure: false
})
```

Max 8 tasks, 4 concurrent. Results are returned in input order. When `abortOnFailure` is `true`, the first failed task cancels remaining siblings.

### Chain mode

```ts
subagent({
  chain: [
    { agent: "scout", task: "Find API routes" },
    { agent: "worker", task: "Based on this, implement the routes: {previous}" },
  ]
})
```

`{previous}` in each step's task is replaced with the previous step's output. The chain stops on the first failed step.

## Result status

Each `SubAgentResult` includes a canonical `status` field:

| Status | Meaning |
|--------|---------|
| `success` | Completed normally |
| `partial` | Truncated (max_tokens, length, context_limit) |
| `error` | Provider error, tool error, or unknown stop reason |
| `aborted` | Cancelled by parent or sibling |
| `timeout` | Exceeded the allowed timeout |

The raw `stopReason` from the Pi SDK is preserved in the result.

## Timeout and cancellation

- **Default timeout:** 10 minutes per child.
- **Per-task/step override:** Use `timeout` in task/step params.
- **Parent cancellation:** Aborting the parent tool call cancels all children.
- **Sibling cancellation:** In parallel mode with `abortOnFailure: true`, the first failed task cancels running siblings.
- **Timeout vs. abort:** Timeout errors set `status: "timeout"` and `stopReason: "timeout"`; parent cancellation sets `status: "aborted"`.
- **Transient provider failures:** One automatic retry runs within the same timeout; Codex WebSocket failures use the SDK's SSE fallback on retry.
- **Transport idle:** The parent tool receives periodic progress heartbeats while a child runs; these do not extend its timeout.

## Extension contract

`pi-subagent` owns the `pi-subagent:run` event contract for one named-agent request. `pi-review` uses it for isolated review. Requests use an immediate boolean `accept()` claim and exactly one `respond()` callback; this suppresses duplicate responders while missing services and timeouts remain caller-controlled.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Compatibility

- Requires `@earendil-works/pi-coding-agent >=0.80.0 <0.83.0`
- Requires `@earendil-works/pi-ai >=0.80.0 <0.83.0`
- Requires `@earendil-works/pi-agent-core >=0.80.0 <0.83.0`
- Requires `@earendil-works/pi-tui >=0.80.0 <0.83.0`
- Requires `typebox >=1.3.0 <2.0.0`
- Requires Node.js >= 20.18

See [`agent-format.md`](./agent-format.md) for all frontmatter fields.
