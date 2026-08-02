# @bacnh85/pi-agy

Google Antigravity CLI (`agy`) bridge for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Offload bulk implementation, scaffolding, repetitive refactors, and exhaustive test generation to Gemini, Claude, or GPT-OSS through `agy`, while Pi retains the conductor role for judgement and verification.

## Install

```bash
pi install npm:@bacnh85/pi-agy
```

## Prerequisites

Install the Antigravity CLI (a Go binary, not pipx):

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
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

Aliases map to agy's canonical machine names (run `agy models` to list them):

| Alias | agy machine name | Typical use |
|-------|------------------|-------------|
| `flash-low` | `gemini-3.6-flash-low` | Trivial, few-step, high-volume work |
| `flash-medium` | `gemini-3.6-flash-medium` | Default coding, exploration, and tests |
| `flash-high` | `gemini-3.6-flash-high` | Difficult agentic work |
| `pro-low` | `gemini-3.1-pro-low` | Advanced reasoning |
| `pro-high` | `gemini-3.1-pro-high` | Hardest Gemini reasoning |
| `sonnet` | `claude-sonnet-4-6` | Normal Claude coding and review |
| `opus` | `claude-opus-4-6-thinking` | Hardest architecture and root-cause review |
| `gpt-oss` | `gpt-oss-120b-medium` | Alternative open model |

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

## How pi-agy shapes the handoff

Pi delegates to agy as a producer, not an autonomous agent. Each call is
framed so the result is verifiable and parseable — this is where pi-agy adds
value over running `agy` bare:

- **Mode-aware flags.** `plan` is read-only. `accept-edits` and `sandbox` both
  write, so pi-agy passes `--dangerously-skip-permissions` for them (headless
  `-p` mode auto-denies writes without it). `plan`/`sandbox` additionally get
  `--output-format json`.
- **Phase-aware prompt framing.** `plan` prompts are prefixed to explore only;
  `sandbox` notes isolation; `accept-edits` gets a verify-loop line.
- **Verify-loop injection.** In `accept-edits`, if the project's `package.json`
  has a `test` script, pi-agy appends `After editing, run \`npm test\` and fix
  failures until it passes.` — implementing Google's own [Best Practices](https://antigravity.google/docs/cli/best-practices)
  ("provide a local verification mechanism… run the local test command").
- **Structured output.** `plan`/`sandbox` return JSON; pi-agy extracts the
  `.response` field so Pi receives the answer, not the raw envelope (with a
  safe fallback to raw text on schema drift).

## Safety

- Pre-flight checks verify `agy` is installed and the CLI can reach its backend (`agy --version` + `agy models`).
- `agy` always runs with detached stdin (`stdio: ['ignore', 'pipe', 'pipe']`) to prevent hanging.
- `--dangerously-skip-permissions` is used **only** for `accept-edits`/`sandbox` (the modes that write), scoped to the `--add-dir` workspace; `plan` never receives it.
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
