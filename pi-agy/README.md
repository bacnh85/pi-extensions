# @bacnh85/pi-agy

Google Antigravity CLI (`agy`) bridge for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Offload bulk implementation, scaffolding, repetitive refactors, and exhaustive test generation to Gemini, Claude, or GPT-OSS through `agy`, while Pi retains the conductor role for judgement and verification.

## Install

```bash
pi install npm:@bacnh85/pi-agy
```

## Prerequisites

Install the Antigravity CLI:

```bash
pipx install antigravity
```

Authenticate (one-time in your terminal):

```bash
agy
```

Verify the CLI works:

```bash
agy --version
agy models
```

## Tool

### `agy_execute`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | string | _required_ | Task instruction for agy |
| `model` | model alias below | `flash-medium` | Antigravity model; takes precedence over `tier` |
| `tier` | `flash` / `flash-lo` / `pro` | — | Legacy Gemini tier compatibility |
| `mode` | `accept-edits` / `plan` / `sandbox` | `accept-edits` | agy execution mode |
| `dir` | string | cwd | Working directory |
| `digest` | boolean | mode-based | Compact output; defaults on for `plan`/`sandbox` and off for `accept-edits` |
| `timeout_ms` | number | `300000` | Timeout in milliseconds |

### Models

| Alias | Antigravity display name | Typical use |
|-------|--------------------------|-------------|
| `flash-low` | Gemini 3.5 Flash (Low) | Trivial, few-step, high-volume work |
| `flash-medium` | Gemini 3.5 Flash (Medium) | Default coding, exploration, and tests |
| `flash-high` | Gemini 3.5 Flash (High) | Difficult agentic work |
| `pro-low` | Gemini 3.1 Pro (Low) | Advanced reasoning |
| `pro-high` | Gemini 3.1 Pro (High) | Hardest Gemini reasoning |
| `sonnet` | Claude Sonnet 4.6 (Thinking) | Normal Claude coding and review |
| `opus` | Claude Opus 4.6 (Thinking) | Hardest architecture and root-cause review |
| `gpt-oss` | GPT-OSS 120B (Medium) | Alternative open model |

Resolution order is explicit `model`, then explicit legacy `tier`, then `flash-medium`. Legacy mappings remain `flash` → `flash-high`, `flash-lo` → `flash-low`, and `pro` → `pro-high`. Run `agy models` if Antigravity changes its display names or plan availability.

### Quota-aware routing

| Work | Produce | Cross-review when consequential |
|------|---------|---------------------------------|
| Routine bulk work | `flash-medium` (Gemini quota group) | `sonnet` with `mode=plan` |
| Claude-group implementation | `sonnet` (Claude quota group) | `flash-medium` with `mode=plan` |
| Hard reasoning | Escalate to `pro-high` or `opus` only after the cheaper model is insufficient | Opposite family |

Batch related work, prefer `digest=true` for non-write calls, and avoid parallel calls inside one shared-quota group. Do not spend both groups on trivial tasks. Pi should review the diff and run verification after every `accept-edits` call.

```text
# Gemini produces, Claude reviews
agy_execute prompt="Implement the approved refactor" model=flash-medium mode=accept-edits
agy_execute prompt="Review the resulting diff" model=sonnet mode=plan digest=true

# Claude produces, Gemini reviews
agy_execute prompt="Fix the parser root cause" model=sonnet mode=accept-edits
agy_execute prompt="Review the resulting diff" model=pro-low mode=plan digest=true
```

## Safety

- Pre-flight checks verify `agy` is installed and the CLI can reach its backend (`agy --version` + `agy models`).
- `agy` always runs with detached stdin (`stdio: ['ignore', 'pipe', 'pipe']`) to prevent hanging.
- Output is truncated to 8000 characters to protect Pi's context window.
- Always review the `git diff` after `accept-edits` mode.

## Development

```bash
npm test
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
