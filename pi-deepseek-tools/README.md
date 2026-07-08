# pi-deepseek-tools

Improves **OpenCode Go DeepSeek V4** (Flash and Pro) tool selection and fixes common tool-input mistakes in Pi.

**Scope:** `opencode-go/deepseek-v4-flash` and `opencode-go/deepseek-v4-pro`. Does not affect direct `deepseek` provider requests, GPT/OpenAI models, or any other provider/model.

The extension does not print prompts, tool schemas, API keys, or response bodies.

## What it does

**Tool-selection guidance** — Injects concise, model-specific rules before each agent turn when relevant tools are active, so the model:
- calls exactly one Pi tool name (never invents `read_file`, `search_files`, etc.);
- prefers Serena semantic tools for code navigation, references, and refactoring;
- uses `read` after Serena identifies the relevant region, or for docs/config/non-code files;
- uses `ls`, `grep`, `find`, or `read` for simple file/text work instead of shelling out;
- uses `bash` only for real commands (tests, builds, git, package-manager, process execution);
- treats path fields as filesystem paths, never markdown links or auto-links;
- inspects with the right tool first, then calls `edit`.

**Tool-input repair** — Wraps Pi's built-in file/shell tools to fix common recoverable argument mistakes before validation:
- `null` on optional fields → omitted;
- JSON strings parsed where the schema expects an array/object;
- `{}` placeholders → `[]` where an array is expected;
- bare strings wrapped as single-item arrays;
- degenerate markdown auto-links in path fields unwrapped (e.g. `[notes.md](http://notes. md)` → `notes.md`);
- `read` with only `limit` defaults to `offset: 1`; with only `offset` defaults to `limit: 2000`.

Valid inputs pass through unchanged (except for path auto-link cleanup).

**Reasoning-content stripping** — On multi-turn conversations, `reasoning_content` from previous assistant messages can cause 400 errors with some providers. This extension automatically strips `reasoning_content` from all *previous* assistant messages before each request, preserving the current turn's reasoning. Controlled by `PI_DEEPSEEK_TOOLS_STRIP_REASONING`.

**Error-recovery hints** — When tool calls fail, the next turn receives a hint: "the previous tool call(s) had errors. Use simpler tool inputs and provide all required fields explicitly." This helps the model recover without wasting a turn.

**Optional strict mode** — Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` to block obvious misses (reading code files before Serena, using `bash` where a dedicated Pi tool is active). Strict mode is opt-in because normal workflows sometimes legitimately need `read` or `bash`.

**Debug logging** — Set `PI_DEEPSEEK_TOOLS_DEBUG=1` to see stderr logs at every decision point: model detection, guidance injection, repairs triggered, blocks, errors, and reasoning-content stripping.

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
  index.ts                 — Pi extension entry point: registers hooks and wrapped tools
  lib/
    deepseek-tools.ts      — Model detection, env-var helpers, path heuristics, guidance generation
    tool-input-repair.ts   — Schema-aware argument repair (6 repair kinds)
    reasoning-content.ts   — Strip reasoning_content from provider request payloads
    logger.ts              — Conditional stderr debug logging
  test/unit/               — Mocha + tsx unit tests
  scripts/                 — Eval harnesses for tool-selection accuracy and repair coverage
```

## Known Limitations

- **Tool-input repair** handles structural argument mismatches (null fields, json-in-string, bare values) but not missing required fields — if the model omits a required argument entirely, the provider will still reject the call.
- **Reasoning-content stripping** preserves the current turn's `reasoning_content` to avoid disrupting thinking continuity. If the provider rejects this too, set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=0`.
- **Direct DeepSeek provider** support is opt-in (`PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1`) and may not work perfectly with all direct DeepSeek API configurations.
