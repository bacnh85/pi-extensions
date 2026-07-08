# pi-deepseek-tools

Improves **OpenCode Go DeepSeek V4** (Flash and Pro) tool selection, fixes common tool-input mistakes, and provides context-aware error recovery in Pi.

**Scope:** `opencode-go/deepseek-v4-flash` and `opencode-go/deepseek-v4-pro`. Optionally also `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro` (direct). Never affects GPT/OpenAI or other providers.

The extension does not print prompts, tool schemas, API keys, or response bodies.

## What it does

**Tool-selection guidance** — Injects concise, model-specific rules before each agent turn when relevant tools are active.

**Tool-input repair** — Wraps Pi's built-in file/shell tools to fix common recoverable argument mistakes before validation:
- `null` on optional fields → omitted;
- JSON strings parsed where the schema expects an array/object;
- `{}` placeholders → `[]` where an array is expected;
- bare strings wrapped as single-item arrays;
- degenerate markdown auto-links in path fields unwrapped (e.g. `[notes.md](http://notes. md)` → `notes.md`);
- `read` with only `limit` defaults to `offset: 1`; with only `offset` defaults to `limit: 2000`.

Valid inputs pass through unchanged (except for path auto-link cleanup).

**Reasoning-content stripping (opt-in)** — Set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=1` to strip `reasoning_content`, `reasoning`, `thinking_content`, `chain_of_thought`, and `cot` from all *previous* assistant messages before each request, preserving the current turn's reasoning. It is off by default because OpenCode Go DeepSeek V4 can 401 after tool turns when provider history is mutated. Optional truncation via `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS` trims long reasoning values with a `[reasoning truncated]` marker instead of hard-deleting them.

**Context-aware error recovery** — When a tool call fails, the error is categorized (validation, rate-limit, timeout, tool-not-found, api-error, or unknown) and the next turn receives a targeted recovery hint. **Adaptive**: repeats of the same tool failure get an escalated hint with the repeat count.

**Find-misuse interception** — Blocks `find` when the model uses it for a known filename (suggest `read`) or test-file pattern (suggest `bash`). No wasted turns on obvious misuses.

**Optional strict Serena mode** — Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` to block obvious misses (reading code files before Serena, using `bash` where a dedicated Pi tool is active). Strict mode is opt-in because normal workflows sometimes legitimately need `read` or `bash`.

**Status command** — `/deepseek-tools-status` shows current env configuration, repair counts, per-tool error statistics, and last error category at a glance.

**Structured logging** — `PI_DEEPSEEK_TOOLS_DEBUG=1` emits debug-level logs. `PI_DEEPSEEK_TOOLS_LOG_FORMAT=json` writes structured JSON log lines. Warnings and errors are always logged to stderr with `[deepseek-tools:warn]` / `[deepseek-tools:debug]` prefixes.

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

## Commands

| Command | Description |
|---------|-------------|
| `/deepseek-tools-status` | Show current env config, runtime repair/error counts per tool, and last error category. |

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

## Architecture

```
extensions/
  index.ts                 — Pi extension entry point: registers hooks, wrapped tools, commands,
                             adaptive error tracking
  lib/
    deepseek-tools.ts      — Model detection, env-var helpers, path heuristics,
                             guidance generation, error categorization
    tool-input-repair.ts   — Schema-aware argument repair (6 repair kinds)
    reasoning-content.ts   — Strip reasoning/thinking fields from provider request payloads (widened:
                             5 field names + optional max-tokens truncation)
    logger.ts              — Level-aware stderr logging (plain or structured JSON)
  test/unit/               — Mocha + tsx unit tests (69 tests)
  scripts/                 — Eval harnesses for tool-selection accuracy and repair coverage
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|------|
| Guidance not injected | `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | Unset or set to `1` |
| Reasoning 400 errors | Provider rejects reasoning fields (even short ones) | Set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=1` |
| Reasoning 400 errors only on long responses | Provider accepts reasoning but has a content-length limit | Set `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS=1024` to truncate long prior reasoning |
| Tool calls still fail | Model omits required fields entirely | Repair handles structure mismatches but not missing required fields — set `PI_DEEPSEEK_TOOLS_DEBUG=1` and check stderr for repair details |
| `deepseek` provider not matched | Direct DeepSeek support is opt-in | Set `PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1` |
| Excessive reminder messages | Model consistently mis-selects tools | Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` to block instead of remind |
| `/deepseek-tools-status` not found | Extension not loaded | Check settings.json and run `/reload` |
| Repeated same-tool errors | Model isn't adapting | The extension now escalates hints after 2+ failures on the same tool with repeat counts |

## Known Limitations

- **Tool-input repair** handles structural argument mismatches (null fields, json-in-string, bare values) but not missing required fields — if the model omits a required argument entirely, the provider will still reject the call.
- **Reasoning-content stripping** is opt-in because OpenCode Go DeepSeek V4 can reject follow-up turns when provider history is mutated. If enabled, it preserves the current turn's reasoning to avoid disrupting thinking continuity.
- **Direct DeepSeek provider** support is opt-in (`PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1`) and may not work perfectly with all direct DeepSeek API configurations.

## Changelog

### 0.8.0 (next)

- **Reasoning strip is opt-in**: default-off avoids OpenCode Go `Model {{model}} is not supported` failures after tool turns
- **Wider reasoning strip**: when enabled, now handles `thinking_content`, `chain_of_thought`, `cot` in addition to `reasoning_content` and `reasoning`
- **Optional reasoning truncation**: `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS=<N>` truncates long prior reasoning with a marker instead of hard-deleting
- **Lazy fast-path**: returns original payload unchanged when no prior reasoning exists (no clone overhead)
- **Structured clone**: `clonePayload` now uses built-in `structuredClone` for safety
- **Adaptive error recovery**: tracks per-tool error counts; escalates hints with repeat count after 2+ failures on the same tool
- **Enhanced `/deepseek-tools-status`**: shows per-tool error breakdown
- **Eval harness guard**: fails fast when `--model {{model}}` is passed unexpanded and accepts full `provider/model` ids
- **Thinking-effort hint**: rule 8 in guidance suggests `thinking: { type: 'budget_tokens', budget_tokens: 2048 }` for 400 errors
- **Structured logging**: `PI_DEEPSEEK_TOOLS_LOG_FORMAT=json` for programmatic consumption

### 0.7.0

- `/deepseek-tools-status` command
- Error categorization with targeted recovery hints
- Direct DeepSeek provider support (opt-in)
- Improve find-misuse blocking
- Serena-first code navigation in guidance

### 0.6.0

- Tool-input repair with 6 repair kinds
- Find-misuse interception
- Strict Serena mode
- Reasoning-content stripping

### 0.5.0

- Initial release: guidance injection for OpenCode Go DeepSeek V4
