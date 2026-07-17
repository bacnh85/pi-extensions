# Changelog

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
