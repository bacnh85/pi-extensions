# pi-references

External context roots for [Pi](https://pi.dev).

Alias sibling directories or git repositories as `@docs`, `@sdk`, etc., and reference them by name. Local refs resolve at startup; git refs are cloned into a local cache at session start. References with a `description` are injected into the agent's system prompt so the model knows they exist. Inspired by OpenCode's `references` feature.

## Install

```bash
pi install npm:@bacnh85/pi-references
```

## Configuration

Add a `references` object to `.pi/settings.json` (project), `~/.pi/agent/settings.json` (global; `PI_CODING_AGENT_DIR` overrides), or `~/.pi/agents/settings.json` — the first settings.json containing a `references` object wins (files without one are skipped):

```json
{
  "references": {
    "docs": {
      "path": "../product-docs",
      "description": "Use for product behavior and documentation conventions"
    },
    "sdk": {
      "repository": "owner/opencode-sdk-js",
      "branch": "main",
      "description": "Use for JavaScript SDK implementation details"
    }
  }
}
```

### Fields

| Field | Local | Git | Description |
|-------|:-----:|:---:|-------------|
| `path` | ✅ | — | Local reference directory (relative or absolute) |
| `repository` | — | ✅ | Git URL, `host/path`, or GitHub `owner/repo` |
| `branch` | — | ✅ | Optional branch/ref (defaults to repo default) |
| `description` | ✅ | ✅ | When to use the reference (advertised to the agent) |
| `hidden` | ✅ | ✅ | Hide from the agent: excluded from the system-prompt advertisement even when a `description` is set |

### Shorthand

String values are parsed automatically:

```json
{
  "references": {
    "docs": "../docs",
    "sdk": "owner/repo"
  }
}
```

## Command

| Command | Description |
|---------|-------------|
| `/refs` | List configured references and their resolved paths |

## How it works

1. On `session_start`, resolves local paths against the project cwd and ensures git refs are cloned into `~/.pi/agent/refs/<alias>/` (eager, best-effort, non-blocking).
2. On every `before_agent_start`, appends the reference list (those with descriptions) to the system prompt so the model can read files under those roots when relevant.
3. The `/refs` command lists what's configured and where it resolved.

## Alias rules

Reference aliases cannot be empty or contain `/`, whitespace, backticks, or commas.
Dot segments are rejected: an alias of `.` or `..` is dropped (line ~107 of
`extensions/index.js`), since `join(cacheRoot, "..")` would resolve the ref
outside the cache root entirely.
Branch names starting with `-` are dropped: a dashed branch in a repo ref
(line ~190) could be parsed by `git clone` as an option (argument injection
from config), so a branch like `-x` is silently not passed as `--branch`.

## Why

Cross-repo work — referencing a sibling project, an SDK, upstream docs — is common but friction-heavy in Pi (manual `@../path` or copying). `pi-references` makes external context roots first-class and discoverable to the agent.

## License

MIT
