# pi-deepseek-tools

Improves **OpenCode Go DeepSeek V4** (Flash and Pro) tool selection, fixes common tool-input mistakes, provides context-aware error recovery, and optimizes thinking budgets automatically.

**Scope:** `opencode-go/deepseek-v4-flash` and `opencode-go/deepseek-v4-pro`. Optionally also `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro` (direct). Never affects GPT/OpenAI or other providers.

The extension does not print prompts, tool schemas, API keys, or response bodies.

## What it does

**Tool-selection guidance** — Injects concise, model-specific rules before each agent turn when relevant tools are active. Results are cached per tool-set combination to eliminate regenerating the same text.

**Tool-input repair** — Wraps Pi's built-in file/shell tools to fix common recoverable argument mistakes before validation:
- `null` on optional fields → omitted;
- JSON strings parsed where the schema expects an array/object;
- `{}` placeholders → `[]` where an array is expected;
- bare strings wrapped as single-item arrays;
- degenerate markdown auto-links in path fields unwrapped (e.g. `[notes.md](http://notes. md)` → `notes.md`);
- `read` with only `limit` defaults to `offset: 1`; with only `offset` defaults to `limit: 2000`.

Valid inputs pass through unchanged (except for path auto-link cleanup). TypeBox schemas are cached via WeakMap so validation overhead is ~0.1μs per call after the first.

**Leaked content cleaning (always on)** — Strips leaked thinking headers (`Reasoning:`, `Thinking:`, `Chain of Thought:`) and plain-text tool-call syntax (`` `read("file.ts")` ``) from message content. Handles both string and multi-modal content arrays.

**Reasoning-content stripping (opt-in)** — Set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=1` to strip `reasoning_content`, `reasoning`, `thinking_content`, `chain_of_thought`, and `cot` from all *previous* assistant messages before each request, preserving the current turn's reasoning. It is off by default because OpenCode Go DeepSeek V4 can 401 after tool turns when provider history is mutated. Optional truncation via `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS` trims long reasoning values with a `[reasoning truncated]` marker instead of hard-deleting.

**Auto thinking-effort adjustment** — Set `PI_DEEPSEEK_TOOLS_THINKING_BUDGET=1024` to cap thinking tokens on every turn. No turn-type detection — just one flat value. Helps avoid 400 errors on tool-heavy turns.

**Adaptive reminder→block escalation** — Set `PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS=5` to auto-block tool misses after N reminders on the same pattern. Escalation is per-miss-type (e.g., `serena-before-read`, `bash→ls`, `find→read`) so reminders eventually turn into blocks instead of repeating indefinitely.

**Safety guardrails for dangerous bash** — Set `PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS=1` to intercept the two destructive commands that actually happen: `rm -rf /` and `dd to block device`. Warns and blocks before execution.

**Context-aware error recovery** — When a tool call fails, the error is categorized (validation, rate-limit, timeout, tool-not-found, api-error, or unknown) and the next turn receives a targeted recovery hint. **Adaptive**: repeats of the same tool failure get an escalated hint with the repeat count. Rate-limit errors include cooldown timing info in the hint.

**Find-misuse interception** — Blocks `find` when the model uses it for a known filename (suggest `read`) or test-file pattern (suggest `bash`). No wasted turns on obvious misuses.

**Optional strict Serena mode** — Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` to block obvious misses (reading code files before Serena, using `bash` where a dedicated Pi tool is active). Strict mode is opt-in because normal workflows sometimes legitimately need `read` or `bash`.

**Status command** — `/deepseek-tools-status` shows current env configuration, repair counts, per-tool error statistics, log level, thinking budgets, and last error category at a glance.

**Structured logging** — `PI_DEEPSEEK_TOOLS_DEBUG=1` enables debug output. `PI_DEEPSEEK_TOOLS_LOG_FORMAT=json` writes structured JSON log lines. pony tail: binary toggle, no multi-level complexity.

## Scope

Default scope is `opencode-go/deepseek-v4-flash` and `opencode-go/deepseek-v4-pro`. Set `PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1` to also cover `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro` (direct provider).

These models are **never** affected:
- `openai-codex/gpt-5.5`
- all other providers/models

## Enable

Add to `/Users/bacnh/.pi/agent/settings.json`:

```json
"/Volumes/Dev/agents/pi-extensions/pi-deepseek-tools"
```

Then restart Pi or run `/reload` in an existing session.

Quick-start config: copy `.env.example` to `.env` and uncomment the settings you need.

## Commands

| Command | Description |
|---------|-------------|
| `/deepseek-tools-status` | Show current env config, runtime repair/error counts per tool, thinking budgets, log level, and last error category. |

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | on | Disable tool-selection guidance injection. |
| `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` | off | Block obvious Serena/dedicated-tool misses. |
| `PI_DEEPSEEK_TOOLS_STRIP_REASONING=1` | off | Enable reasoning-content stripping from provider requests. |
| `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS=2048` | unlimited | Truncate prior reasoning values longer than N chars (with `[reasoning truncated]` marker) instead of deleting entirely. |
| `PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1` | off | Also apply to direct `deepseek` provider (not just OpenCode Go). |
| `PI_DEEPSEEK_TOOLS_REPAIR_ENABLED=0` | on | Disable tool-input argument repair. |
| `PI_DEEPSEEK_TOOLS_DEBUG=1` | off | Enable stderr debug logging for diagnostics. |
| `PI_DEEPSEEK_TOOLS_LOG_FORMAT=json` | plain | Output structured JSON log lines instead of plain text. |
| `PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY=200` | 100 | Maximum tracked tool errors in the error history (LRU eviction). |
| `PI_DEEPSEEK_TOOLS_THINKING_BUDGET=1024` | unset | Flat thinking budget for all turns. Unset = no cap (model decides). |
| `PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS=5` | off | Auto-block tool-selection misses after N reminders on the same pattern. |
| `PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS=1` | off | Block dangerous bash commands (`rm -rf /`, fork bombs, `dd` to block device, `curl|sh`, etc.). |

## Architecture

```
extensions/
  index.ts                 — Pi extension entry point: registers hooks, wrapped tools, commands,
                             adaptive error tracking, auto thinking adjustment
  lib/
    deepseek-tools.ts      — Model detection, env-var helpers, path heuristics,
                             guidance generation (cached), error categorization
    tool-input-repair.ts   — Schema-aware argument repair (6 repair kinds, WeakMap-cached)
    reasoning-content.ts   — Strip reasoning/thinking fields + leaked content cleaning
                              (thinking headers, plain-text tool calls, 5 field names)
    logger.ts              — Level-aware stderr logging (4 levels + off, plain or JSON)
  test/unit/               — Mocha + tsx unit tests (87+ tests)
  scripts/                 — Eval harnesses for tool-selection accuracy, repair coverage, and
                             ponytail+munin integration; repair benchmark
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|------|
| Guidance not injected | `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | Unset or set to `1` |
| Reasoning 400 errors | Provider rejects reasoning fields (even short ones) | Set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=1` |
| Reasoning 400 errors only on long responses | Provider accepts reasoning but has a content-length limit | Set `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS=1024` to truncate long prior reasoning |
| 400 errors on tool-heavy turns | Thinking budget too large | Set `PI_DEEPSEEK_TOOLS_THINKING_BUDGET_TOOL_HEAVY=512` to auto-lower on tool-heavy turns |
| Tool calls still fail | Model omits required fields entirely | Repair handles structure mismatches but not missing required fields — set `PI_DEEPSEEK_TOOLS_LOG_LEVEL=debug` and check stderr for repair details |
| `deepseek` provider not matched | Direct DeepSeek support is opt-in | Set `PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1` |
| Excessive reminder messages | Model consistently mis-selects tools | Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` to block instead of remind |
| `/deepseek-tools-status` not found | Extension not loaded | Check settings.json and run `/reload` |
| Repeated same-tool errors | Model isn't adapting | The extension escalates hints after 2+ failures on the same tool with repeat counts |
| Leaked `Reasoning:` text in responses | V4 sometimes emits thinking as plaintext | Leaked content cleaning is always on — no action needed |

## Known Limitations

- **Tool-input repair** handles structural argument mismatches (null fields, json-in-string, bare values) but not missing required fields — if the model omits a required argument entirely, the provider will still reject the call.
- **Reasoning-content stripping** is opt-in because OpenCode Go DeepSeek V4 can reject follow-up turns when provider history is mutated. If enabled, it preserves the current turn's reasoning to avoid disrupting thinking continuity.
- **Direct DeepSeek provider** support is opt-in (`PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1`) and may not work perfectly with all direct DeepSeek API configurations.
- **Auto thinking adjustment** only takes effect when the corresponding env vars are set. Without them, the model's default thinking budget is used.

## Changelog

### 0.9.0 (next)

- **TypeBox schema caching**: WeakMap cache eliminates recompilation on every tool call (~5μs → ~0.1μs)
- **Leaked content cleaning**: always-on stripping of `Reasoning:`/`Thinking:` headers and plain-text tool calls from message content
- **Auto thinking-effort adjustment**: injects thinking budget based on turn type (tool-heavy, error, analysis) when env vars are set
- **Bounded error history**: `PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY=N` with LRU eviction (default 100)
- **Guidance string caching**: cached per tool-set combination, eliminating regenerated strings on every turn
- **Adaptive reminder→block escalation**: `PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS=N` auto-blocks tool misses after N reminders on the same pattern
- **Safety guardrails for dangerous bash**: `PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS=1` blocks `rm -rf /` and `dd to block device`
- **Flat thinking budget**: `PI_DEEPSEEK_TOOLS_THINKING_BUDGET=N` caps thinking tokens on every turn
- **Enhanced `/deepseek-tools-status`**: shows thinking budget, auto-block config, dangerous command guard status, reminder counts
- **ponytail-guided simplifications**: removed speculative log levels, turn-type thinking detection, and 10 of 12 dangerous command patterns
- **93 unit tests** (93 passing)

### 0.8.0

- Reasoning strip is opt-in (default-off)
- Wider reasoning strip: `thinking_content`, `chain_of_thought`, `cot`
- Optional reasoning truncation: `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS=<N>`
- Lazy fast-path and structured clone for reasoning strip
- Adaptive error recovery with per-tool counts and escalated hints
- Enhanced `/deepseek-tools-status` with per-tool error breakdown
- Eval harness guard and thinking-effort hint in guidance
- Structured logging: `PI_DEEPSEEK_TOOLS_LOG_FORMAT=json`

### 0.7.0

- `/deepseek-tools-status` command
- Error categorization with targeted recovery hints
- Direct DeepSeek provider support (opt-in)
- Find-misuse blocking improvements
- Serena-first code navigation in guidance

### 0.6.0

- Tool-input repair with 6 repair kinds
- Find-misuse interception
- Strict Serena mode
- Reasoning-content stripping

### 0.5.0

- Initial release: guidance injection for OpenCode Go DeepSeek V4
