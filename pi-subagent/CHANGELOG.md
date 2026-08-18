# Changelog

## 0.15.2 (2026-08-18)

### Improvements

- Colored borders around thread viewer overlay using agent color.
- Colored scroll-indicator arrows (↑/↓) matching agent color.
- Scroll offset only resets when switching to a different thread, not on every refresh.

## 0.15.1 (2026-08-17)

### Improvements

- Project-local agent approval is now a single select — **Allow once / Trust for this session / Deny** — instead of a yes/no confirm repeated on every delegation. "Trust for this session" remembers the project agents dir for the session (cleared on `session_start`); dismissed dialogs and Deny cancel the delegation. Headless sessions still fail closed.
- New test coverage for the approval gate (Deny / dismissed / headless / trust-remembering / session_start clearing).

## 0.15.0 (2026-08-09)

### Packaging

- Added `extensions/background.ts`, `history.ts`, `result.ts`, `widget.ts`
  to `files[]` — they were imported by `index.ts` but missing from the
  manifest, so the published package would have failed to load.

### Compact collapsed result (no tool-call trace in conversation)

Completed single subagent results no longer dump the tool-call trace
(`→ ls`, `→ grep`, `→ read …`) into the conversation block. The collapsed
view now shows the answer preview + usage, matching Claude Code's
`⎿ Done (N tool uses · tokens)` and pi-task's `⎿ <summary> (Ctrl+O to expand)`
UX. The full trace remains available via Ctrl+O (expanded) and `/agent`
(thread viewer); the hint text now points to both.

- `renderSingleResult` collapsed branch: `✓ agent` + `⎿ <first ~200 chars of
  final output>` + usage + `(Ctrl+O to expand · /agent for full thread)`.
- Removed the dead `renderDisplayItems` / `COLLAPSED_ITEM_COUNT` — the
  collapsed path no longer lists tool calls (was the noise source).
- Parallel and chain collapsed views were already compact (per-task/step
  one-liners) — unchanged.
- New tests: `render.test.ts` (5 cases) asserting collapsed shows the answer
  preview and NOT the tool-call trace, plus error/no-output/hint paths.

### Live progress widget (Phase 1)

A persistent above-editor widget now shows what each running subagent is doing
right now — spinner, agent name, elapsed time, tool-call count, and the latest
tool call with ✓/✗/⟳ status. Fed by live `threadStore` subscriptions (per SDK
session event), not JSONL polling. Replaces the old 30s plain-text
"still running…" heartbeat.

- One block per running thread (single, parallel, chain), capped at 8 +
  `+N more running`.
- Latest tool-call line with `done`/`error`/`in_progress` status derived by
  pairing assistant `toolCall` parts against later `toolResult` messages.
- Clears automatically when no threads are running.
- Inspired by [pi-task](https://github.com/heyhuynhgiabuu/pi-task)'s widget UX,
  but cheaper: in-process SDK gives per-event live data without polling.

### Background mode + task control (Phase 2)

- `background: true` (single mode only) runs the subagent detached: `execute`
  returns immediately with a receipt, and completion arrives as a follow-up
  turn via `sendMessage({ triggerTurn: true, deliverAs: "followUp" })`.
- `operation: "status"` / `operation: "cancel"` with `taskId` inspects or
  cancels a running background task without relaunching.
- A `pi-subagent-complete` message renderer renders the follow-up turn
  compactly (status icon, agent, output, usage).
- Background tasks are aborted and the widget is disposed on `session_shutdown`.

### Structured result + history registry (Phase 3)

- New `result.ts`: parent-side structured extraction of the child's final
  message (summary, findings, files, caveats, next steps) by detecting
  markdown headers. No child XML contract — we structure the output ourselves.
- New `history.ts`: durable metadata under `.pi/subagent-history.json`. Every
  completed task (foreground and background) is recorded.
- `/subagent history` lists recent delegations with status and timestamp.
- On restart, prior-session `running` entries are marked `interrupted` (honest
  about the in-process ceiling: we cannot resume a live SDK session).

## 0.14.1 (2026-08-07)

### Improvements

- Widen peer dependency range to support Pi 0.84.0 (`>=0.80.0 <0.85.0`).
  No code changes — verified compatible against the 0.84.0 SDK types.

## 0.14.0 (2026-08-05)

### Git worktree isolation (`sandbox: worktree`)

Agents can now run in an isolated **git worktree** instead of the parent's
working tree — the safe way to run parallel implementation agents that edit
files. Set `sandbox: worktree` in agent frontmatter (see `agent-format.md`).

- Child file mutations land in `.pi-worktrees/<id>` under the repo root; the
  main checkout stays untouched, so two parallel `worker` agents can never
  clobber each other's edits.
- On completion, a unified diff of the child's changes is returned as
  `result.patch` and shown in the thread viewer as a `🌿 worktree` badge.
- **Merging is explicit** — the parent receives the diff and applies it via
  `apply_patch` / cherry-pick / discard; nothing is auto-merged.
- The worktree is removed in a `finally` on success, error, or abort.
- Falls back to in-process execution with a warning when the cwd is not a git
  repo (`ponytail`: isolation optimization, not a hard requirement).
- Wired through the `subagent` tool, the service path (`pi-subagent:run` for
  pi-review), and `runner.ts`'s `runSubAgent` (new `sandbox` + `exec` options).

## 0.13.0 (2026-07-31)

### Subagents inherit parent extensions & tools by default

Subagents can now use the same tools the main agent has — including extension
 tools like `web_search`, `serena_*`, `munin_*`, `obsidian`, and `notebooklm`.
 Previously children were restricted to the 7 Pi built-in tools (`read, grep,
 find, ls, bash, edit, write`) and could not load extensions, which made
 delegation far less capable than the main agent.

This follows the **Claude Code model**: subagents inherit the parent's tool set,
 with a small denylist (`subagent` — recursive delegation is always prevented)
 and per-agent restriction via an explicit `tools:` line.

**Tool resolution:**
- Agent **omits** `tools:` → inherits **all parent tools** (minus denylist).
  `worker` and `general-purpose` now do this.
- Agent **specifies** `tools:` → restricted to that list, validated against
  built-ins ∪ parent tools.
- `sandbox: read-only` / `readOnly` → filters the effective set to read-only.
- Denied tools (`subagent`) are **silently stripped**, never errored — whether
  explicitly listed or inherited. Inheritance must not crash on a tool the
  child cannot have (the inherited set always includes `subagent`).

**Smart lean optimization:** extensions are only loaded when the effective tool
 set contains at least one non-built-in tool. Recon agents with a built-in-only
 `tools:` line (scout, tester, planner, reviewer) stay cheap — zero extension
 overhead, same fast cold-start.

**Per-child extension loader.** Children that need extensions get a FRESH
 `DefaultResourceLoader` each run (extensions only: no skills, prompt templates,
 AGENTS.md, or themes). The loader must NOT be cached/shared: extensions capture
 the ExtensionAPI at factory-load time, and its actions delegate to the runtime
 the factory was given (pi.getAllTools() → runtime.getAllTools()). A shared
 loader's runtime is never the one any single child binds — children then hit
 the runtime's throwing "Extension runtime not initialized" stubs on the first
 provider request (pi-model-tools' before_provider_request calls pi.getAllTools())
 or stale-ctx errors after the first child's dispose invalidates the shared
 runtime. A per-child loader keeps every captured `pi` pointing at a runtime the
 child both binds and owns. reload() per child re-reads extension files +
 re-runs factories; acceptable for short-lived children.

Extension load errors in children are logged, not fatal. Project-extension trust
 is inherited from the parent (children never prompt).

### Bundled agent changes

- `worker` and `general-purpose`: removed the explicit `tools:` line so they
  inherit all parent tools.
- `scout`, `tester`, `planner`, `reviewer`: unchanged (still lean + restricted).

## 0.12.4 (2026-07-30)

### Improvements

- Widen Pi peer dependency range to <0.84.0 for Pi 0.83.0 compatibility.

## 0.12.3 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.12.0 (2026-07-24)

### Model routing

- Chains are now **free-first** to conserve the metered opencode-go budget: paid DeepSeek moves to the **last** position so free nvidia/openrouter fallbacks are tried first. Previously DeepSeek sat at position 2 and burned quota whenever the free GLM primary rate-limited.
- **Removed two dead fallbacks** found by live-testing every free model on 2026-07-24: `nvidia/moonshotai/kimi-k2.6` (HTTP 404, NVCF not provisioned for the account) and `nvidia/z-ai/glm-5.2` (timeout). These are non-rate-limit failures, so the rate-limit retry loop did not advance past them — a subagent that reached them died instead of falling through to the working `:free` entries behind them.
- New chains: scout/tester `glm-5-turbo` → `nvidia/gpt-oss-20b` → `deepseek-v4-flash`; worker/general-purpose `glm-5.1` → `nvidia/mistral-small-4-119b-2603` → `nemotron-3-super:free` → `deepseek-v4-flash`; planner/reviewer `glm-5.2` → `nemotron-3-ultra:free` → `deepseek-v4-pro`.
- Verified-working free additions: `nvidia/openai/gpt-oss-20b` (1.2s), `nvidia/mistralai/mistral-small-4-119b-2603` (2.6s, 119B reasoning), `openrouter/nvidia/nemotron-3-nano-30b-a3b:free` (1.2s).

## 0.11.0 (2026-07-23)

### Model routing

- Bundled roles now route through **zai-coding-cn** (GLM) as the primary provider, with a provider-diverse fallback chain: `zai-coding-cn` (free GLM) → `opencode-go` (cheap `deepseek-v4-flash`) → `nvidia` (free NIM) → `openrouter` (`:free` models, last resort).
- Fast tier (scout, tester) uses `glm-5-turbo` with `thinking: off` (GLM reasoning is ~11× slower; these are mechanical roles).
- Strong-coding tier (worker, general-purpose) uses `glm-5.1`; deep-reasoning tier (planner, reviewer) uses `glm-5.2` (the only GLM with reasoning-effort control).
- opencode-go contributes one DeepSeek model per role, matched to strength: `deepseek-v4-flash` for scout/tester/worker/general-purpose, `deepseek-v4-pro` for planner/reviewer — never its GLM models, which cost ~$1.40/$4.40 per M versus zai-coding-cn's free GLM.
- Chains are cost-ascending on failure and spread load 2/2/2 across the GLM tiers to respect GLM's low concurrency; the existing rate-limit retry walks the chain on 429s.
- Free-model fallbacks verified live against the OpenRouter API: `nemotron-3-super:free` (worker/general-purpose) and `nemotron-3-ultra:free` (planner/reviewer) respond correctly with reasoning on. scout/tester omit a `:free` entry because their `thinking: off` conflicts with reasoning-mandatory `:free` models (`gpt-oss-20b:free` returns HTTP 400 when reasoning is disabled; `gemma-4-31b:free` rate-limits, `cohere/north-mini-code:free` returns empty).

## 0.9.2 (2026-07-16)

### Pi SDK compatibility

- Removed use of the deleted `AuthStorage.inMemory()` API so delegated planner and other subagents start on Pi 0.80.10.

## 0.9.1 (2026-07-16)

### Activity-aware timeouts

- Child `timeout` values now define a sliding inactivity window (three minutes by default); real SDK lifecycle events reset it while a fixed 20-minute hard cap remains.
- `/agent` distinguishes real activity from transport heartbeats and reports idle versus hard timeouts.

## 0.9.0 (2026-07-16)

### Model routing

- Bundled roles now select the first authenticated model from an ordered preference list, with the authenticated parent model as the final fallback.
- Added read-only `planner` and focused `tester` roles for consequential design and cheap routine verification.
- Agent files accept `models` as a YAML array or comma-separated string; legacy `model` remains the explicit first choice.

## 0.8.2 (2026-07-16)

### Reliability

- Transient provider and transport failures receive one bounded SDK retry. Retrying Codex WebSocket failures uses the session's SSE fallback, waits through retrying `agent_end` events, clears recovered error state, preserves nonzero failure exit codes, and reports explicit timeout messages.

## 0.8.1 (2026-07-15)

### Review handoff

- Reviewer findings now require reproduction or evidence, expected behavior, and acceptance criteria so implementation agents receive self-contained actionable issues.

## 0.6.0 (2026-07-12)

### Security (breaking changes)

- **Project-agent confirmation removed from tool schema.** The `confirmProjectAgents` parameter is no longer exposed to the LLM. Project-agent approval is enforced via trusted configuration only. Interactive sessions prompt for confirmation; headless sessions fail closed unless `allowUnconfirmedProjectAgents` is explicitly enabled through trusted configuration (environment variable `PI_SUBAGENT_ALLOW_UNCONFIRMED_PROJECT_AGENTS=true` or pi settings).

- **Child working directories confined to the workspace.** Tool-specified `cwd` values are validated against the workspace root. Relative paths are resolved within the workspace; `..` traversal, absolute paths outside the workspace, and symlink escapes are rejected. A trusted `allowExternalCwd` setting (env `PI_SUBAGENT_ALLOW_EXTERNAL_CWD=true` or pi settings) can opt out.

- **Tool allowlist enforced.** Child agent tools are validated against a fixed allowlist: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`. The `subagent` tool is always rejected. Unknown or misspelled tool names produce clear errors. Read-only service execution cannot gain `bash`, `edit`, or `write`.

- **Default timeout added.** Every child execution receives a default 10-minute timeout (`DEFAULT_TIMEOUT_MS`). Maximum allowed timeout is 60 minutes (`MAX_TIMEOUT_MS`). Timeout errors are distinguishable from parent cancellation.

### Reliability

- **Abort signal composition fixed.** `createCombinedAbortSignal()` correctly combines multiple abort signals with proper listener cleanup. Works without `AbortSignal.any()` via a manual fallback that removes all listeners after the first abort.

- **Parallel abort listeners cleaned up.** Parent-signal listeners attached during parallel execution are removed in a `finally` block after completion.

- **Canonical result status.** `SubAgentResult.status` classifies outcomes as `"success"`, `"partial"`, `"error"`, `"aborted"`, or `"timeout"`. Known Pi SDK stop reasons are classified explicitly; unknown reasons default conservatively to `"error"`.

- **Validation hardened.** Numeric and collection limits (timeout, max parallel tasks, concurrency, chain length, output cap, instructions length) are enforced at both schema and runtime levels.

- **Parallel result ordering preserved.** Results remain in input-task order regardless of completion order.

- **`abortOnFailure` behavior deterministic.** First canonical failure aborts running siblings; queued tasks never start; completed tasks retain their results.

### Agent discovery

- **Malformed agent files produce diagnostics.** Missing name, missing description, empty name, invalid model, invalid thinking levels, and unreadable files are reported with file path and severity. Valid agents continue to load.

### Packaging

- **Peer dependency ranges constrained.** `@earendil-works/pi-*` dependencies use `>=0.80.0 <0.81.0`; `typebox` uses `>=1.3.0 <2.0.0`.

- **Node engine requirement added.** `engines.node: ">=20.18"`.

- **Scripts fixed.** `npm test` uses locally installed `mocha` (no `npx`). Added `npm run check` (typecheck + test).

- **Package metadata updated.** `homepage` points to the package subdirectory.

- **`security.ts` added to published files.**

- **`CHANGELOG.md` added to published files.**

### Documentation

- **Security model section** added to README covering project-agent trust, cwd confinement, tool validation, timeout defaults, cancellation, result status, and compatibility.

### Backward compatibility

- `SubAgentResult.status` is a new field; existing consumers that ignore unknown fields remain compatible.
- Tool schema no longer accepts `confirmProjectAgents`; model-generated calls using it will be silently ignored (the field is fully removed from the schema, not just deprecated).
- Child `cwd` values that previously worked outside the workspace are now rejected unless the trusted `allowExternalCwd` setting is enabled.
- `combineAbortSignals()` is still exported from `runner.ts` but delegates to `createCombinedAbortSignal()` internally.
