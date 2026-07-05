# pi-deepseek-tools

Pi extension that improves **OpenCode Go DeepSeek V4 Flash** tool selection and recoverable tool-input mistakes in Pi.

Runtime behavior is intentionally scoped to:

```text
opencode-go/deepseek-v4-flash
```

It does **not** target `opencode-go/deepseek-v4-pro`, direct `deepseek` provider requests, or GPT/OpenAI models. Pi/OpenCode Go already carries the DeepSeek request-compatibility metadata (`max_tokens`, DeepSeek thinking format, and reasoning-content handling); this extension focuses on terminal tool-choice behavior and Flash-only tool argument repair.

The extension does not print prompts, tool schemas, API keys, or response bodies.

## What it improves

For `opencode-go/deepseek-v4-flash`, the extension injects concise, model-specific guidance before each agent turn when relevant tools are active:

- call exactly one of the provided Pi tool names; never invent names such as `read_file` or `search_files`;
- prefer Serena semantic tools for code-symbol, declaration, reference, implementation, rename, and refactor work;
- use `read` after Serena identifies the relevant region, or for docs/config/non-code files;
- use `ls`, `grep`, `find`, or `read` for simple file/text work rather than shelling out;
- use `bash` only for real shell commands such as tests, builds, git, package-manager, or process execution;
- path fields are filesystem paths, not markdown links or auto-links;
- for edits, inspect with the right tool first and then call `edit`.

The extension also has an optional reminder/strict mode for obvious misses, such as reading code files before Serena or using simple `bash` commands where a dedicated Pi tool is active. Runtime reminders are passive steering messages and do not trigger extra model turns.

## Tool input repair

For `opencode-go/deepseek-v4-flash`, the extension wraps Pi's built-in file/shell tools and repairs only known recoverable argument shapes before validation:

- optional fields sent as `null` are omitted;
- JSON strings are parsed only where the schema expects an array/object;
- `{}` placeholders become `[]` only where the schema expects an array;
- bare strings become single-item arrays only where the schema expects an array;
- degenerate markdown auto-links in path-like fields are unwrapped, e.g. `[notes.md](http://notes. md)` → `notes.md`;
- `read` calls with only `limit` default to `offset: 1`; calls with only `offset` default to `limit: 2000` and include a note in the result.

Valid inputs are left untouched except for path auto-link cleanup. File content fields are not recursively parsed, so JSON-looking text written to disk remains text.

## Scope guarantees

Runtime hooks are guarded so these are unaffected:

- `opencode-go/deepseek-v4-pro`
- `deepseek/deepseek-v4-flash`
- `deepseek/deepseek-v4-pro`
- `openai-codex/gpt-5.5`
- all other providers/models

## Local verification

Run unit tests from the repository root:

```bash
npm test --prefix pi-deepseek-tools
```

Run the package TypeScript check:

```bash
cd pi-deepseek-tools && npm exec --package=typescript -- tsc --noEmit
```

Run a package dry-run:

```bash
cd pi-deepseek-tools && npm pack --dry-run --json
```

## Enable for testing

```bash
pi -e ./pi-deepseek-tools/extensions/index.ts \
  --provider opencode-go --model deepseek-v4-flash --thinking high
```

JSON-mode smoke test:

```bash
pi -e ./pi-deepseek-tools/extensions/index.ts \
  --provider opencode-go --model deepseek-v4-flash --thinking high \
  --mode json --no-session --no-context-files \
  --tools read,bash,grep,find,ls,serena_get_symbols_overview,serena_find_symbol \
  "Inspect symbols in pi-deepseek-tools/extensions/index.ts and summarize them."
```

Inspect `tool_execution_start` events. For semantic code prompts, DeepSeek V4 Flash should prefer `serena_get_symbols_overview`, `serena_find_symbol`, or `serena_find_referencing_symbols` before raw code reads or shell searches.

Negative scope check for Pro:

```bash
pi -e ./pi-deepseek-tools/extensions/index.ts \
  --provider opencode-go --model deepseek-v4-pro --thinking high \
  --mode json --no-session --no-context-files \
  --tools read,bash,grep,find,ls,serena_get_symbols_overview,serena_find_symbol \
  "Inspect symbols in pi-deepseek-tools/extensions/index.ts and summarize them."
```

The extension should not inject Flash guidance or reminders for Pro.

## DeepSeek Flash vs GPT-5.5 tool-selection eval

Use the eval helper to compare tool choice across models:

```bash
node pi-deepseek-tools/extensions/scripts/eval-tool-selection.mjs \
  --provider opencode-go --model deepseek-v4-flash --trials 3 \
  --out /tmp/pi-deepseek-flash-eval.json
```

Guidance-disabled control:

```bash
node pi-deepseek-tools/extensions/scripts/eval-tool-selection.mjs \
  --provider opencode-go --model deepseek-v4-flash --guidance off --trials 3 \
  --out /tmp/pi-deepseek-flash-control.json
```

GPT-5.5 baseline:

```bash
node pi-deepseek-tools/extensions/scripts/eval-tool-selection.mjs \
  --provider openai-codex --model gpt-5.5 --thinking xhigh --trials 3 \
  --out /tmp/pi-gpt-55-baseline.json
```

Pro negative-scope run:

```bash
node pi-deepseek-tools/extensions/scripts/eval-tool-selection.mjs \
  --provider opencode-go --model deepseek-v4-pro --trials 1 \
  --out /tmp/pi-deepseek-pro-negative.json
```

The helper runs Pi in JSON mode, parses `tool_execution_start` events, and reports first-tool accuracy, Serena-before-read failures, simple `bash` substitutions, and invalid tool-argument errors.

Suggested quality target: Flash with guidance enabled should achieve at least 90% first-tool correctness on deterministic read-only prompts, or be within 5-10 percentage points of the GPT-5.5 baseline if the baseline is lower. Hallucinated/unavailable tool rate should be zero.

## Enable globally

Add the package path to `/Users/bacnh/.pi/agent/settings.json`:

```json
"/Volumes/Dev/agents/pi-pi-deepseek-tools"
```

Then restart Pi or run `/reload` in an existing session.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | on | Disable OpenCode Go DeepSeek V4 Flash tool-selection system-prompt guidance. |
| `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` | off | Block obvious Serena/dedicated-tool misses for OpenCode Go DeepSeek V4 Flash when relevant tools are active. |

Strict mode is opt-in because normal workflows sometimes legitimately need `read` or `bash`.
