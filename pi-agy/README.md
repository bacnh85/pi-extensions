# pi-agy

Google Antigravity CLI (`agy`) bridge for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Offload bulk implementation, scaffolding, repetitive refactors, and exhaustive test generation to a cheaper Gemini model through `agy`, while Pi retains the conductor role for judgement and verification.

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
| `tier` | `flash` / `flash-lo` / `pro` | `flash` | Gemini model tier |
| `mode` | `accept-edits` / `plan` / `sandbox` | `accept-edits` | agy execution mode |
| `dir` | string | cwd | Working directory |
| `digest` | boolean | mode-based | Compact output; defaults on for `plan`/`sandbox` and off for `accept-edits` |
| `timeout_ms` | number | `300000` | Timeout in milliseconds |

## Safety

- Pre-flight checks verify `agy` is installed and the CLI can reach its backend (`agy --version` + `agy models`).
- `agy` always runs with detached stdin (`stdio: ['ignore', 'pipe', 'pipe']`) to prevent hanging.
- Output is truncated to 8000 characters to protect Pi's context window.
- Always review the `git diff` after `accept-edits` mode.

## Development

```bash
cd pi-agy
npm install
npm test
```
