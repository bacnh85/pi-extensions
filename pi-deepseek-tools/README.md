# pi-deepseek-tools

Pi extension that improves **DeepSeek V4** (Flash and Pro) tool calling for **OpenCode Go** models. Fixes common tool-input mistakes, strips leaked thinking content, provides context-aware error recovery, and offers optional safety guardrails.

**Scope:** `opencode-go/deepseek-v4-flash` and `opencode-go/deepseek-v4-pro`. Optionally also `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro` (direct). Never affects GPT/OpenAI or other providers.

The extension does not print prompts, tool schemas, API keys, or response bodies.

## Who should use this

- Pi users using OpenCode Go DeepSeek V4 Flash/Pro
- Users seeing invalid tool arguments
- Users seeing repeated wrong tool selection
- Users seeing reasoning-content related API errors
- Users wanting status/debug visibility for DeepSeek tool behavior

## Install

```bash
pi install npm:@bacnh85/pi-deepseek-tools
```

Then reload Pi:

```text
/reload
```

## Verify installation

```text
/deepseek-tools-status
```

## Supported models

| Provider | Model | Default behavior |
|---|---|---|
| opencode-go | deepseek-v4-flash | enabled |
| opencode-go | deepseek-v4-pro | enabled |
| deepseek | deepseek-v4-flash | opt-in (`PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1`) |
| deepseek | deepseek-v4-pro | opt-in (`PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1`) |
| openai-codex / gpt | any | never modified |

## Features

**Tool-selection guidance** — Injects concise, model-specific rules before each agent turn when relevant tools are active. Results are cached per tool-set combination.

**Tool-input repair** — Wraps Pi's built-in file/shell tools to fix common recoverable argument mistakes before validation:
- `null` on optional fields → omitted
- JSON strings parsed where the schema expects an array/object
- `{}` placeholders → `[]` where an array is expected
- bare strings wrapped as single-item arrays
- degenerate markdown auto-links in path fields unwrapped (e.g. `[notes.md](http://notes. md)` → `notes.md`)
- `read` with only `limit` defaults to `offset: 1`; with only `offset` defaults to `limit: 2000`

Valid inputs pass through unchanged (except for path auto-link cleanup). TypeBox schemas are cached via WeakMap.

**Leaked content cleaning (always on)** — Strips leaked thinking headers (`Reasoning:`, `Thinking:`, `Chain of Thought:`) and plain-text tool-call syntax (`read("...")`) from message content. Handles both string and multi-modal content arrays.

**Reasoning-content stripping (opt-in)** — Set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=1` to strip reasoning fields from prior assistant messages before each request, preserving the current turn's reasoning. Optional truncation via `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS`.

**Thinking budget control (opt-in)** — Set `PI_DEEPSEEK_TOOLS_THINKING_BUDGET=N` to cap thinking tokens on every turn. Helps avoid 400 errors on tool-heavy turns.

**Safety guardrails (opt-in)** — Set `PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS=1` to intercept destructive commands before execution. Blocks only `rm -rf /` and `dd` to block devices. This is not a sandbox and does not replace user review.

**Adaptive reminder→block escalation (opt-in)** — Set `PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS=N` to auto-block tool-selection misses after N reminders on the same pattern.

**Context-aware error recovery** — Tool errors are categorized (validation, rate-limit, timeout, tool-not-found, api-error, unknown) and the next turn receives a targeted recovery hint. Repeats of the same tool failure get an escalated hint with the repeat count.

**Read-on-code-file blocking** — Reading a code file (`.ts`, `.py`, `.go`, etc.) without Serena first is **blocked by default** when Serena tools are available. Only docs, config, logs, and generated output bypass the block.

**Find-misuse interception** — Blocks `find` when the model uses it for a known filename (suggests `read`) or test discovery (lets through).

**Optional strict Serena mode** — `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` extends blocking to `bash`-for-dedicated-tool misses (`bash ls`, `bash grep`, `bash cat`, `bash find`).

**Status command** — `/deepseek-tools-status` shows configuration, repair counts, per-tool error statistics, and last error category.

## Configuration

| Variable | Default | Accepted values | Purpose |
|---|---|---|---|
| `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | on | `0`/`off`/`false` to disable | Tool-selection guidance injection |
| `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` | off | `1`/`on`/`true` to enable | Block bash-for-dedicated-tool misses (read-on-code-file is blocked by default) |
| `PI_DEEPSEEK_TOOLS_STRIP_REASONING=1` | off | `1`/`on`/`true` to enable | Strip reasoning fields from prior assistant messages |
| `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS=2048` | unlimited | positive integer | Truncate long prior reasoning values |
| `PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1` | off | `1`/`on`/`true` to enable | Also apply to direct `deepseek` provider |
| `PI_DEEPSEEK_TOOLS_REPAIR_ENABLED=0` | on | `0`/`off`/`false` to disable | Tool-input argument repair |
| `PI_DEEPSEEK_TOOLS_DEBUG=1` | off | `1`/`on`/`true` to enable | stderr debug logging |
| `PI_DEEPSEEK_TOOLS_LOG_FORMAT=json` | plain | `json` | Structured JSON log lines |
| `PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY=200` | 100 | positive integer | Maximum tracked tool errors in the error history |
| `PI_DEEPSEEK_TOOLS_THINKING_BUDGET=1024` | unset | non-negative integer | Flat thinking budget for all turns |
| `PI_DEEPSEEK_TOOLS_AUTO_BLOCK_AFTER_REMINDERS=5` | off | positive integer | Auto-block tool-selection misses after N reminders |
| `PI_DEEPSEEK_TOOLS_BLOCK_DANGEROUS_COMMANDS=1` | off | `1`/`on`/`true` to enable | Block dangerous bash commands |

## Commands

| Command | Description |
|---|---|
| `/deepseek-tools-status` | Show configuration, runtime repair/error counts, thinking budget, and last error category. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Guidance not injected | `PI_DEEPSEEK_TOOLS_SELECTION_GUIDANCE=0` | Unset or set to `1` |
| Reasoning 400 errors | Provider rejects reasoning fields | Set `PI_DEEPSEEK_TOOLS_STRIP_REASONING=1` |
| Reasoning 400 errors only on long responses | Provider has content-length limit | Set `PI_DEEPSEEK_TOOLS_REASONING_MAX_TOKENS=1024` |
| 400 errors on tool-heavy turns | Thinking budget too large | Set `PI_DEEPSEEK_TOOLS_THINKING_BUDGET=512` |
| Tool calls still fail | Model omits required fields entirely | Set `PI_DEEPSEEK_TOOLS_DEBUG=1` and check stderr |
| `deepseek` provider not matched | Direct support is opt-in | Set `PI_DEEPSEEK_TOOLS_DIRECT_DEEPSEEK=1` |
| Excessive reminder messages | Model consistently mis-selects tools | Set `PI_DEEPSEEK_TOOLS_STRICT_SERENA=1` |
| `/deepseek-tools-status` not found | Extension not loaded | Check settings.json and run `/reload` |
| Repeated same-tool errors | Model isn't adapting | Extension auto-escalates hints after 2+ failures |
| Leaked `Reasoning:` text in responses | V4 sometimes emits thinking as plaintext | Leaked content cleaning is always on |

## Trust and security

This package is a **Pi extension** — it can influence tool behavior, intercept tool calls, and modify provider requests. By installing it, you are granting it these capabilities.

- The extension **does not** read, store, or transmit API keys, credentials, prompts, or response contents.
- It operates entirely locally within the Pi agent process.
- The source repository (`github.com/bacnh85/pi-extensions`) is currently **private** while under active development. A public source release is planned. Until then, audit the installed package at `node_modules/@bacnh85/pi-deepseek-tools/`.

If you are uncomfortable running unverified Pi extensions, you can inspect each hook and tool registration in the `extensions/` directory of the installed package before use.

## Known limitations

- **Tool-input repair** handles structural mismatches but not missing required fields. If the model omits a required argument entirely, the provider still rejects the call.
- **Reasoning-content stripping** is opt-in because OpenCode Go DeepSeek V4 can reject follow-up turns when provider history is mutated. It preserves the current turn's reasoning to avoid disrupting thinking continuity.
- **Direct DeepSeek provider** support is opt-in and may not work perfectly with all API configurations.
- **Auto thinking adjustment** only takes effect when `PI_DEEPSEEK_TOOLS_THINKING_BUDGET` is set. Without it, the model uses its default thinking budget.
- **Dangerous command guard** is opt-in and blocks only `rm -rf /` and `dd` to block devices. It is not a sandbox and does not replace user review of commands.
- **Argument repair** is best-effort and focused on recoverable harness mismatches — not malicious or deeply malformed inputs.
- **Leaked content cleaning** can strip tool-call-like text that looks like a Pi tool invocation, even when it was intentional content.

## Development install

For local development:

```bash
git clone https://github.com/bacnh85/pi-extensions.git
cd pi-extensions/pi-deepseek-tools
npm install
```

Then add the local path to Pi's `settings.json`:

```json
"/path/to/pi-extensions/pi-deepseek-tools"
```

## Testing

```bash
# Run unit tests
npm test

# TypeScript type-check
npm run typecheck
```

Tests use Mocha + tsx with Node.js assert. No test framework mocks — tests use minimal fake Pi API objects.

## Release checklist

- [ ] Run `npm run typecheck` — TypeScript compiles cleanly
- [ ] Run `npm test` — all tests passing
- [ ] Verify README env vars match source code exactly
- [ ] Verify package metadata has no broken private links
- [ ] Verify `npm pack --dry-run` includes only intended files
- [ ] Verify `pi install npm:@bacnh85/pi-deepseek-tools` works in a clean environment
- [ ] Verify `/deepseek-tools-status` command works after install
- [ ] Update changelog
- [ ] Bump version in `package.json`
- [ ] Publish: `npm publish`

## Changelog

### 0.9.2

- **README cleanup**: Removed local dev path from install instructions, added trust/security section, fixed env var documentation to match source code
- **Env var fix**: Standardized on `PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY` (was using `PI_DEEPSEEK_TOOLS_ERROR_HISTORY` internally), default is now 100 as documented
- **Dangerous command fix**: Fixed `logger.ts` runtime crash (invalid `process.stderr.;` expression)
- **Dangerous command docs**: Reduced guard documentation to match actual implementation (2 patterns, not 12)
- **Package metadata**: Added `bugs` field, LICENSE file, `typecheck` script, updated keywords
- **Test coverage**: Added env-var parsing tests for `maxErrorHistory`, `thinkingBudget`, `blockDangerousEnabled`, and invalid-value fallback behavior

### 0.9.1

- Fixed OpenCode Go DeepSeek V4 `{{model}}` payload wrapping — `before_provider_request` now returns the replacement payload directly instead of `{ payload }`, which caused 401 `ModelError: Model {{model}} is not supported` with high/xhigh thinking levels

### 0.9.0

- TypeBox schema caching (WeakMap, ~0.1μs per call)
- Leaked content cleaning (always-on for DeepSeek V4)
- Flat thinking budget via `PI_DEEPSEEK_TOOLS_THINKING_BUDGET`
- Bounded error history via `PI_DEEPSEEK_TOOLS_MAX_ERROR_HISTORY`
- Guidance string caching per tool-set
- Adaptive reminder→block escalation
- Safety guardrails for dangerous bash (2 patterns: `rm -rf /` and `dd` to block device)
- Enhanced `/deepseek-tools-status`
- 93 unit tests

### 0.8.0

- Reasoning strip is opt-in (default-off)
- Wider reasoning field coverage
- Optional reasoning truncation
- Adaptive error recovery with per-tool counts
- Enhanced status command
- Structured logging

### 0.7.0

- `/deepseek-tools-status` command
- Error categorization with recovery hints
- Direct DeepSeek provider support (opt-in)
- Find-misuse blocking

### 0.6.0

- Tool-input repair (6 repair kinds)
- Find-misuse interception
- Strict Serena mode
- Reasoning-content stripping

### 0.5.0

- Initial release: guidance injection for OpenCode Go DeepSeek V4
