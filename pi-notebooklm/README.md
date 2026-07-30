# @bacnh85/pi-notebooklm

Pi extension for **Google NotebookLM** (personal/Pro) — one `notebooklm` tool backed by [`notebooklm-py`](https://github.com/teng-lin/notebooklm-py) CLI bridge (v0.7.3).

Covers notebooks, sources, grounded chat, research, Studio artifacts (Audio Overviews, video, slides, reports, infographics, quizzes, flashcards, mind maps, data tables), downloads, notes, sharing, and organization.

## Requirements

1. **Python** 3.10+ with `uv`, `pipx`, or `pip`.
2. **notebooklm-py** CLI installed:

   ```bash
   uv tool install "notebooklm-py[browser]"
   ```

   The `[browser]` extra provides Playwright, which is required for interactive
   `notebooklm login`. See the
   [upstream docs](https://github.com/teng-lin/notebooklm-py) for pipx/venv
   alternatives.

3. **One-time authentication** (in a terminal, not through Pi):

   ```bash
   notebooklm login    # auto-installs Chromium on first run
   notebooklm auth check --test --json
   ```

   If `playwright install chromium` fails during login, install it manually:

   ```bash
   uv tool run --from 'notebooklm-py[browser]' playwright install chromium
   ```

   Auth stays in NotebookLM CLI's own storage. This extension never reads or copies credentials.

## Install

```bash
pi install npm:@bacnh85/pi-notebooklm
```

## Configuration

**Zero env vars.** Just ensure `notebooklm` is in your PATH and authentication is valid.

## Usage

One tool: `notebooklm` with an argument array.

```
notebooklm args=["list", "--json"]
notebooklm args=["auth", "check", "--test", "--json"]
notebooklm args=["create", "Research Notebook", "--json"]
notebooklm args=["source", "add", "https://example.com/doc", "-n", "<notebook-id>", "--json"]
notebooklm args=["source", "add", "Inline text here...", "-n", "<notebook-id>", "--json"]
notebooklm args=["ask", "What are the conclusions?", "-n", "<notebook-id>", "--json"]
notebooklm args=["generate", "audio", "-n", "<notebook-id>"]
notebooklm args=["artifact", "wait", "<task-id>", "-n", "<notebook-id>", "--json"]
notebooklm args=["download", "audio", "-a", "<artifact-id>", "output.mp3"]
```

### Examples

| Task | Tool call |
|------|-----------|
| List notebooks | `args=["list", "--json"]` |
| Auth check | `args=["auth", "check", "--test", "--json"]` |
| Create notebook | `args=["create", "Project Alpha", "--json"]` |
| Add URL source (auto-detected) | `args=["source", "add", "https://...", "-n", "<id>", "--json"]` |
| Add text source (auto-detected) | `args=["source", "add", "Some content", "-n", "<id>", "--json"]` |
| Wait for source readiness | `args=["source", "wait", "<src-id>", "-n", "<id>", "--json"]` |
| List sources | `args=["source", "list", "-n", "<id>", "--json"]` |
| Grounded chat | `args=["ask", "Summarize key findings", "-n", "<id>", "--json"]` |
| New conversation (destructive) | `args=["ask", "--new", "-y", "question", "-n", "<id>"], confirm: true` |
| Audio overview generation | `args=["generate", "audio", "-n", "<id>"]` then `args=["artifact", "poll", "<task>", "-n", "<id>", "--json"]` |
| Download audio | `args=["download", "audio", "-a", "<art-id>", "output.mp3"]` |
| Delete notebook (destructive) | `args=["delete", "-n", "<id>", "-y"], confirm: true` |
| Auth logout (destructive) | `args=["auth", "logout"], confirm: true` (no `-y` needed) |
| Clear context (destructive) | `args=["clear"], confirm: true` (no `-y` needed) |

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `args` | `string[]` | Yes | CLI arguments (excluding `notebooklm` executable) |
| `confirm` | `boolean` | No | Confirm destructive operations (delete, clean, remove, logout, new conversation, file overwrite) |
| `timeout_ms` | `number` | No | Timeout in ms (default 60000, max 600000) |

### Rules

- **Use full notebook IDs** and explicit `-n` for parallel agent calls. Shared `notebooklm use` context can race.
- **Request `--json`** on supported commands for structured output.
- **Wait for source readiness** before chat or generation (`source wait -n <id>` / `source list -n <id>`).
- **Async generation**: start `generate <type>` → get task ID → poll with `artifact poll` or block with `artifact wait`.
- **Destructive operations** require `confirm: true`. Most also need `-y`/`--yes` in args. Exceptions: `auth logout`, `clear`, `skill uninstall`, `history --clear` (CLI v0.7.3 does not support -y/--yes for these).
- **File overwrites**: `download`, `source fulltext`, or `skill install` with `--force` overwrites workspace files — requires `confirm: true`.

### Blocked commands (run directly in terminal)

- `notebooklm login` — browser-based authentication

## Scope

Personal and Pro NotebookLM, not NotebookLM Enterprise. This extension relies on `notebooklm-py` which uses Google's undocumented web RPCs. Google provides no stability guarantee for personal/Pro NotebookLM automation.

## Upgrading

When Google changes its private RPCs, the fix normally only requires upgrading `notebooklm-py`, not this extension:

```bash
uv tool upgrade notebooklm-py
```

Prefer the latest patch release — RPC drift fixes ship upstream.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `exit 1` + auth error | Expired session | `notebooklm auth check --test --json`, re-login if needed |
| Rate limit errors | Quota exceeded | Wait and retry; generation is quota-limited |
| CLI not found | Missing install | `uv tool install "notebooklm-py[browser]"` |
| `BrowserType.launch_persistent_context` | Playwright browser not found | Auto-installed on first `notebooklm login`; if fails, run `uv tool run --from 'notebooklm-py[browser]' playwright install chromium` |
| Timeout (exit 2) | Command too slow | Increase `timeout_ms` or split into smaller steps |

## Development

```bash
npm test
npm run typecheck
npm pack --dry-run
```

## How it works

A single `notebooklm` tool bridges to the `notebooklm-py` CLI via `pi.exec()`, using an argument array rather than a raw `run` string. This avoids shell injection, quote-parsing bugs, and malformed escaping. The extension validates inputs, gates destructive operations using exact command-path matching, truncates oversized output with byte-aware limits, and surfaces actionable error messages — while delegating all NotebookLM protocol handling to the upstream CLI.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
