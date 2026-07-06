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

**Optional strict mode** — Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` to block obvious misses (reading code files before Serena, using `bash` where a dedicated Pi tool is active). Strict mode is opt-in because normal workflows sometimes legitimately need `read` or `bash`.

## Scope

Runtime hooks are guarded — these models are unaffected:
- `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro`
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
| `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | on | Disable tool-selection guidance. |
| `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` | off | Block obvious Serena/dedicated-tool misses. |
