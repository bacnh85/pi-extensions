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

**Reasoning-content stripping** — On multi-turn conversations, `reasoning_content` from previous assistant messages can cause 400 errors with some providers. This extension automatically strips `reasoning_content` from all *previous* assistant messages before each request, preserving the current turn's reasoning. A lazy pre-check avoids cloning the payload when no prior reasoning exists.

**Context-aware error recovery** — When a tool call fails, the error is categorized (validation, rate-limit, timeout, tool-not-found, api-error, or unknown) and the next turn receives a targeted recovery hint instead of a generic message. This helps the model self-correct more effectively.

**Find-misuse interception** — Blocks `find` when the model uses it for a known filename (suggest `read`) or test-file pattern (suggest `bash`). No wasted turns on obvious misuses.

**Optional strict Serena mode** — Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` to block obvious misses (reading code files before Serena, using `bash` where a dedicated Pi tool is active). Strict mode is opt-in because normal workflows sometimes legitimately need `read` or `bash`.

**Status command** — `/deepseek-tools-status` shows current configuration, repair counts, error statistics, and last error category at a glance.

**Structured logging** — `PI_DEEPSEEK_TOOLS_DEBUG=1` emits debug-level logs. Warnings and errors (tool failures, error categories) are always logged to stderr with `[deepseek-tools:warn]` / `[deepseek-tools:error]` prefixes.

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
| `/deepseek-tools-status` | Show current config (env vars), runtime repair/error counts, and last error category. |

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | on | Disable tool-selection guidance injection. |
| `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` | off | Block obvious Serena/dedicated-tool misses. |
| `PI_DEEPSEEK_TOOLS_STRIP_REASONING=0` | on | Disable `reasoning_content` stripping from provider requests. |
| `PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1` | off | Also apply to direct `deepseek` provider (not just OpenCode Go). |
| `PI_DEEPSEEK_TOOLS_REPAIR_ENABLED=0` | on | Disable tool-input argument repair. |
| `PI_DEEPSEEK_TOOLS_DEBUG=1` | off | Enable stderr debug logging for diagnostics. |

## Architecture

```
extensions/
  index.ts                 — Pi extension entry point: registers hooks, wrapped tools, and /deepseek-tools-status command
  lib/
    deepseek-tools.ts      — Model detection, env-var helpers, path heuristics, guidance generation,
                             error categorization
    tool-input-repair.ts   — Schema-aware argument repair (6 repair kinds)
    reasoning-content.ts   — Strip reasoning_content from provider request payloads
    logger.ts              — Level-aware stderr logging (info, warn, error, debug)
  test/unit/               — Mocha + tsx unit tests (63 tests)
  scripts/                 — Eval harnesses for tool-selection accuracy and repair coverage
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Guidance not injected | `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | Unset or set to `1` |
| Reasoning 400 errors | Provider rejects `reasoning_content` on any message | Set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=0` |
| Tool calls still fail | Model omits required fields entirely | Repair handles structure mismatches but not missing required fields — set `PI_DEEPSEEK_TOOLS_DEBUG=1` and check stderr for repair details |
| `deepseek` provider not matched | Direct DeepSeek support is opt-in | Set `PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1` |
| Excessive reminder messages | Model consistently mis-selects tools | Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` to block instead of remind |
| `/deepseek-tools-status` not found | Extension not loaded | Check settings.json and run `/reload` |

## Known Limitations

- **Tool-input repair** handles structural argument mismatches (null fields, json-in-string, bare values) but not missing required fields — if the model omits a required argument entirely, the provider will still reject the call.
- **Reasoning-content stripping** preserves the current turn's `reasoning_content` to avoid disrupting thinking continuity. If the provider rejects this too, set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=0`.
- **Direct DeepSeek provider** support is opt-in (`PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1`) and may not work perfectly with all direct DeepSeek API configurations.
