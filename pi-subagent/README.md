# @bacnh85/pi-subagent

Isolated in-process subagents for Pi. The `subagent` tool supports single, parallel (8 tasks, 4 concurrent), and chained execution; `/agent` opens inspectable child threads. A live progress widget shows running tasks above the editor; `background: true` runs detached with follow-up-turn completion.

## Role-based model routing

Models are selected **by function**, not fixed per agent. A *role* maps a
function (`fast`, `coder`, `smart`, or your own) to an ordered fallback chain
in `~/.pi/agent/settings.json` under `subagent.roles`:

```json
{
  "subagent": {
    "roles": {
      "fast": ["zai-coding-cn/glm-5-turbo", "nvidia/openai/gpt-oss-20b", "opencode-go/deepseek-v4-flash"],
      "coder": "zai-coding-cn/glm-5.1, opencode-go/deepseek-v4-flash",
      "smart": "*"
    },
    "agentModels": { "reviewer": "@smart:high" },
    "agentThinking": { "reviewer": "low" }
  }
}
```

- Bundled agents reference roles in frontmatter (`model: "@fast"`) — remap a
  function once and every agent using it follows.
- Role values: string (comma chain) or array. `*` / `@default` = parent model.
- A trailing `:level` (`off|minimal|low|medium|high|xhigh|max`) on any entry
  overrides the agent's thinking for that match (`"@smart:high"`); openrouter
  `:free` ids are left intact.
- `subagent.agentModels` overrides a single agent's models without editing its
  file. Repo `.pi/settings.json` overlays the global mapping when the project
  is trusted (read-only; saves go to the global file).
- `subagent.agentThinking` overrides a single agent's thinking without
  editing its file. Precedence: matched candidate's `:level` suffix →
  `agentThinking` → agent frontmatter `thinking`.
- Without any settings, bundled defaults reproduce today's chains exactly.

`/subagent` opens the interactive role editor (TUI panel via the shared
`@bacnh85/pi-config-panel` kernel; prints the effective mapping headless).
The panel supports `+ Add role` / `− Remove role` (custom roles are deletable,
built-ins reset to their bundled default) and shows each agent's default
(no-override) chain on its row, plus a thinking row per agent (blank = file
default). `/subagent list` lists agents, `/subagent <name>` shows an agent's
resolved chain and effective thinking, and `/subagent @role` (or
`/subagent fast`) shows a role's chain and the agents using it.

## Live progress widget

When subagents run, a persistent widget appears above the editor showing each
running task: spinner, agent name, elapsed time, tool count, and the latest tool
call with ✓/✗/⟳ status. The widget clears when no tasks are running. Fed by live
SDK session events — no polling.

## Background mode

Single-mode tasks can run detached with `background: true`:

```ts
subagent({ agent: "planner", task: "Design the cache layer", background: true })
```

The tool returns immediately with a receipt (including a `taskId`), and when
the subagent finishes, the result arrives as a follow-up turn that the parent
agent reads and acts on. Use task control to inspect or cancel:

```ts
subagent({ operation: "status", taskId: "bg-..." })   // read-only snapshot
subagent({ operation: "cancel", taskId: "bg-..." })   // abort a running task
```

You will be notified on completion — do not poll or sleep.

## Herdr delegation

When pi runs inside [herdr](https://herdr.dev), subagent tasks are delegated to
**visible interactive pi sessions in herdr panes** instead of in-process SDK
sessions. Detection is automatic: `HERDR_ENV=1` + a working `herdr` binary.

Topology — one **tab per agent type** (tab label = agent name), one **pane per
agent instance**:

```text
┌─ tab "scout" ──────────┬─ tab "tester" ─────────┐
│ ┌────────┐ ┌────────┐  │ ┌────────┐             │
│ │scout-1 │ │scout-2 │  │ │tester-1│   main pi   │
│ │  (pi)  │ │  (pi)  │  │ │  (pi)  │   (you)     │
│ └────────┘ └────────┘  │ └────────┘             │
└────────────────────────┴────────────────────────┘
```

Each pane runs a full `pi` child with the agent's persona applied via CLI
flags (`--append-system-prompt` pointing at a persona file — herdr's arg
encoder rejects multi-line strings — plus `--model`, `--thinking`, `--tools`). Results come
back through a **report-file contract**: the task prompt asks the child to
write its final report as Markdown to a known path, and the parent reads that
file when the pane settles (pane scrollback is only a best-effort fallback —
TUI agents render on the alternate screen, which never reaches herdr's
scrollback).

The **`herdr` tool** gives the main session oversight of every delegated pane:

```ts
herdr({ action: "list" })                                  // delegated agents + live states
herdr({ action: "status", name: "scout-1" })               // lifecycle state
herdr({ action: "prompt", name: "scout-1", text: "...", wait: true })  // follow-up (continues the child's session)
herdr({ action: "cancel", name: "scout-1" })               // esc, then ctrl+c if still working
herdr({ action: "focus", name: "scout-1" })                // raise the agent's tab
herdr({ action: "close-tab", name: "scout-1" })            // close the tab (only session-created tabs)
```

Trade-offs to know:

- **Shared working tree** — herdr children edit the parent's checkout
  directly; there is no worktree isolation. That is inherent to visible
  sibling agents.
- **Full pi children** — they load AGENTS.md, extensions, and skills, so they
  cost more than the lean SDK runner. Pass `runner: "sdk"` per call for cheap
  routine delegation, or set `subagent.herdr: "off"` in settings.json to
  disable herdr delegation entirely.
- **Permission prompts** — children run with the normal pi approvals; a child
  waiting on a confirmation shows as `blocked`, and a human answers it in the
  pane. Delegated children set `PI_SUBAGENT_HERDR=off` so they never recurse
  into herdr dispatch themselves.
- `background: true` always uses the in-process SDK runner; herdr tasks are
  foreground (all panes are created up front, prompts start under the usual
  concurrency limit).
- **Mid-task user questions**: herdr 0.9.0 does not classify pi's
  `ask_user_question` dialogs as `blocked`, so a delegating parent waits
  until the hard timeout. Answer the question in the pane (the child
  completes and the parent returns), or avoid mid-task questions in herdr
  children.
- **`/reload-runtime` while panes are in flight**: observed behavior —
  mutating control actions (`cancel`/`close-tab`/`forget`) then refuse for
  pre-reload panes ("not delegated by this session"), while
  `status`/`read` keep working by name. Close in-flight panes before
  reloading, or afterwards with `herdr tab close <tabId>`.

Outside herdr nothing changes: the in-process SDK runner is the default.

## Auto-review

Opt-in workflow automation (`subagent.autoReview: true` in settings.json,
default off): after a **user-initiated** turn that made ≥3 file-mutation tool
calls (`edit`, `write`, `apply_patch`, `str_replace_editor`) in an interactive
(TUI) session, the read-only `reviewer` agent is dispatched automatically as a
background task reviewing the current uncommitted diff of the files the turn
touched (new/untracked files are read directly by the reviewer). Its findings
arrive as a background follow-up turn, so an independent review follows every
real coding turn without asking. Precedence: global settings.json → trusted
repo `.pi/settings.json` overlay.

Guards keep it bounded:

- Turns woken by auto-injected messages never trigger a review — custom
  wake-ups (`pi-subagent-complete`) by role, and pi-advisor blocker/concern
  steers by their fixed `Advisor review (` content prefixes (those are plain
  user messages) — so review→fix→review ping-pong can't start.
- Max 3 auto-reviews per session; never while another background task runs.
- The cursor tracks the transcript tail while the setting is off, so enabling
  mid-session never replays accumulated history; `session_start` (startup and
  reload) reseeds it, and a fresh session's first coding turn is reviewed from
  entry zero. Reviewer timeout is 10 minutes; failures are non-blocking. Set
  `PI_SUBAGENT_AUTOREVIEW_DEBUG=1` to trace dispatch decisions on stderr.

## History

Every completed task (foreground and background) is recorded to
`.pi/subagent-history.json`. Use `/subagent history` to list recent
delegations with status and timestamp. Prior-session running tasks are marked
`interrupted` on restart (in-process SDK sessions cannot be resumed).

## Install

```bash
pi install npm:@bacnh85/pi-subagent
```

Requires Node.js >= 20.18.

## Bundled roles

| Role | Model role | Thinking | Tools |
| --- | --- | --- | --- |
| `scout` | `@fast` | off | read, grep, find, ls |
| `tester` | `@fast` | off | read, bash, grep, find, ls |
| `worker` | `@coder` | medium | **inherits all parent tools** |
| `general-purpose` | `@coder` | medium | **inherits all parent tools** |
| `planner` | `@smart` | high | read, grep, find, ls |
| `reviewer` | `@smart` | high | read, grep, find, ls |

Default role chains (overridable via `subagent.roles` in settings.json — see above):

Each role uses the first authenticated preference available through Pi's model registry, then falls back to the authenticated parent model. Chains are **free-first** to conserve the metered opencode-go budget: **zai-coding-cn** (free GLM, primary) → free **nvidia** NIM and **openrouter** `:free` models → **opencode-go** (paid DeepSeek, last resort — one per role: `deepseek-v4-flash` for fast/strong-coding, `deepseek-v4-pro` for deep reasoning). opencode-go's GLM models cost ~$1.40/$4.40 per M versus zai-coding-cn's free GLM, so GLM stays on zai-coding-cn. Fallback models were live-verified on 2026-07-24; `nvidia/moonshotai/kimi-k2.6` and `nvidia/z-ai/glm-5.2` return 404/timeout on the user's account and were removed — non-rate-limit failures kill the subagent instead of advancing the chain. User/project agent files remain stronger overrides and may set legacy `model`, ordered `models`, and `thinking`.

**Tool inheritance.** Agents without an explicit `tools:` line (worker, general-purpose) inherit every tool the parent session has — including extension tools like `web_search`, `serena_*`, `munin_*`, `obsidian`, and `notebooklm`. Agents with an explicit `tools:` list (scout, tester, planner, reviewer) are restricted to those tools and, when the list contains only built-ins, run in a lean loader with no extension overhead. To force an agent lean even while inheriting, set `tools: read, bash, edit, write, grep, find, ls`. The `subagent` tool itself is always denied to children (no recursive delegation).

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

Children use in-memory SDK sessions. Agents that inherit parent tools load the parent's extensions (web, Serena, Munin, …) into the child; agents restricted to built-in tools run in a lean loader with no extensions, skills, prompt templates, or automatic `AGENTS.md` loading. The optional `instructions` argument passes a bounded 16 KB task/repository contract.

Threads are session-memory only and are cleared when Pi replaces or reloads the session. Timeout and parent cancellation propagate to child sessions. Subagents cannot recursively invoke `subagent`.

## Security model

### Project-local agents

Agent files under `.pi/agents/` are controlled by the current repository. A project agent's system prompt may instruct a child to execute shell commands or modify files.

- **Project-agent approval cannot be disabled by the model.** The `confirmProjectAgents` parameter is not exposed in the tool schema. Confirmation policy comes from trusted user configuration only.
- **Interactive sessions** prompt the user before executing project agents (**Allow once / Trust for this session / Deny**); "Trust for this session" remembers the project agents dir until the session ends. Dismissed dialogs and Deny cancel the delegation.
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
- **Read-only restriction:** When a service requests read-only execution, only the built-in reads plus the read-only extension allowlist (FFF, Windows, web, Serena, Munin — see `READ_ONLY_TOOLS` in `extensions/security.ts`) are permitted. `bash`, `edit`, and `write` are rejected.

Unknown or misspelled tool names produce clear diagnostics. Duplicate tool names are deduplicated.

### Git worktree isolation (`sandbox: worktree`)

Set `sandbox: worktree` in an agent's frontmatter to run it in an isolated git
worktree (`.pi-worktrees/<id>` under the repo root) instead of the parent's
working tree. This is the safe way to run **parallel implementation** agents:
two `worker` agents editing the same files can no longer clobber each other —
each writes into its own checkout.

- All file mutations land in the worktree; the main checkout stays untouched.
- On completion, the unified diff of the child's changes is included in the
  tool result as a `🌿 worktree patch` block (capped at the per-task output
  limit) and shown in the thread viewer as a `🌿 worktree` badge.
- **Merging**: by default the parent merges explicitly via `apply_patch` /
  `git apply` / discard. Pass `merge: "3way"` (per call/item) to have the diff
  applied automatically to the parent checkout via `git apply --3way` once the
  child completes — conflicts leave git's conflict markers in place, are
  reported in the result (`mergeStatus: "conflict"`), and the patch is still
  delivered for manual merging. Nothing is ever silently resolved. Applies are
  serialized so parallel siblings cannot race the checkout.
- Children start from `HEAD`: uncommitted changes in the parent checkout are
  invisible to the child and will surface as apply conflicts when merging.
- The worktree is removed on completion (success, error, or abort).
- Requires git; when the cwd is not a git repo, the agent falls back to
  in-process execution with a warning (`ponytail`: isolation optimization,
  not a hard requirement).


### Timeouts

Every child execution receives a timeout:

- **Default inactivity window:** 3 minutes (`DEFAULT_TIMEOUT_MS`); real SDK lifecycle activity resets it.  Overridable with Environment Variable `PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS` 
- **Absolute cap:** Default 20 minutes for every child, even when active. Overridable with Environment variable `PI_SUBAGENT_HARD_TIMEOUT_MINS` 
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

- **Default inactivity window:** 3 minutes per child (`PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS`, range 1–60).
- **Absolute cap:** 20 minutes per child, even when active (`PI_SUBAGENT_HARD_TIMEOUT_MINS`, range 1–60). See *Timeouts* above.
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

- Requires `@earendil-works/pi-coding-agent >=0.80.0 <0.86.0`
- Requires `@earendil-works/pi-ai >=0.80.0 <0.86.0`
- Requires `@earendil-works/pi-agent-core >=0.80.0 <0.86.0`
- Requires `@earendil-works/pi-tui >=0.80.0 <0.86.0`
- Requires `typebox >=1.3.0 <2.0.0`
- Requires Node.js >= 20.18

See [`agent-format.md`](./agent-format.md) for all frontmatter fields.
