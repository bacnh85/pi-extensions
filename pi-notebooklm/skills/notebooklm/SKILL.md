---
name: notebooklm
description: >
  Google NotebookLM — notebooks, sources, grounded chat, research, and Studio
  artifacts (Audio Overviews, video, slides, reports, quizzes, etc.) via the
  notebooklm-py CLI bridge (v0.7.3).
argument-hint: "[args...]"
license: MIT
---

# NotebookLM Skill

Provides agent access to Google's NotebookLM through the `notebooklm` tool.

## Prerequisites

1. Install the upstream CLI:

   ```bash
   uv tool install "notebooklm-py[browser]"
   ```

   See [notebooklm-py docs](https://github.com/teng-lin/notebooklm-py) for pipx/venv alternatives.

2. Authenticate in a terminal (one-time):

   ```bash
   notebooklm login    # auto-installs Chromium on first run
   notebooklm auth check --test --json
   ```

   If `playwright install chromium` fails during login, run it manually:

   ```bash
   uv tool run --from 'notebooklm-py[browser]' playwright install chromium
   ```

## Tool usage

Single `notebooklm` tool with argument array:

```
notebooklm args=["list", "--json"]
notebooklm args=["auth", "check", "--test", "--json"]
notebooklm args=["create", "Research Notebook", "--json"]
notebooklm args=["source", "add", "https://...", "-n", "<notebook-id>", "--json"]
notebooklm args=["source", "add", "Inline text content...", "-n", "<notebook-id>", "--json"]
notebooklm args=["ask", "Summarize findings", "-n", "<notebook-id>", "--json"]
notebooklm args=["generate", "audio", "-n", "<notebook-id>"]
notebooklm args=["artifact", "wait", "<task-id>", "-n", "<notebook-id>", "--json"]
notebooklm args=["download", "audio", "-a", "<artifact-id>", "output.mp3"]
```

## Command map (v0.7.3)

| Category | Commands |
|----------|----------|
| **Auth/health** | `auth check --test --json`, `doctor --json`, `status`, `use <id>`, `clear` (requires `confirm: true`, no `-y`) |
| **Notebooks** | `list --json`, `create <title> --json`, `rename -n <id> "New Title"`, `delete -n <id> -y` (with `confirm: true`), `summary -n <id>`, `metadata -n <id> --json` |
| **Sources** | `source add <content> -n <id> --json` (auto-detects url/file/youtube/text), `source add-drive <file-id> <title> -n <id>`, `source add-research "<query>" -n <id> --mode deep --no-wait`, `source list -n <id> --json`, `source wait <src-id> -n <id> --json`, `source get <src-id>`, `source fulltext <src-id>`, `source guide <src-id>`, `source refresh <src-id>`, `source stale <src-id>`, `source rename <src-id> "New Title"`, `source delete -y <src-id>`, `source delete-by-title <title> -n <id> -y` |
| **Grounded chat** | `ask <question> -n <id> --json` (returns citations via `references[]`), `ask --new -y <question> -n <id> --json` (new conversation, requires `confirm: true` + `-y`), `ask -c <conv-id> "follow up"`, `configure -n <id> --persona <text>`, `history -n <id> --json` |
| **Research** | `research status -n <id> --json`, `research wait -n <id> --json`, `source add-research "<query>" -n <id> --mode deep --no-wait` |
| **Studio generation** | `generate audio -n <id>`, `generate video -n <id>`, `generate slide-deck -n <id>`, `generate report -n <id>`, `generate infographic -n <id>`, `generate quiz -n <id>`, `generate flashcards -n <id>`, `generate mind-map -n <id>`, `generate data-table -n <id>`, `generate cinematic-video -n <id>` |
| **Artifacts** | `artifact list -n <id> --json`, `artifact get <art-id>`, `artifact poll <task-id> -n <id> --json`, `artifact wait <task-id> -n <id> --json`, `artifact retry <task-id>`, `artifact rename <art-id> "New Name"`, `artifact delete -y <art-id>`, `artifact export <art-id> --title "..." --type [docs\|sheets]` |
| **Downloads** | `download audio [output-path] -a <artifact-id>`, `download video [output-path] -a <artifact-id>`, `download slide-deck [output-path] -a <artifact-id>` (also: `--all`, `--latest`, `--name <title>`, `--dry-run`) |
| **Notes** | `note list -n <id> --json`, `note get <note-id>`, `note create <content> -n <id> -t "Title"`, `note rename <note-id> "New Title"`, `note save <note-id> --title "..." --content "..."`, `note delete -y <note-id>` |
| **Sharing** | `share status -n <id> --json`, `share public --enable\|--disable`, `share add <email> --permission viewer\|editor`, `share remove <email>`, `share update <email> --permission <level>`, `share view-level full\|chat` |
| **Organization** | `language set <code>`, `language get`, `language list`, `profile list --json`, `profile switch <name>`, `profile create <name>`, `profile rename <name> "New Name"`, `profile delete -y <name>` |

## Rules

- **Use full notebook IDs** and explicit `-n` in parallel agent workflows. Shared `notebooklm use` context can race across calls.
- **Wait for sources** before chat or generation: `source wait <src-id> -n <id> --json` or check with `source list -n <id> --json`.
- **Async generation**: call `generate <type> -n <id>` → get task ID → poll with `artifact poll <task-id> -n <id> --json` or block with `artifact wait`.
- **Destructive operations** (delete, clean, remove, logout, clear, conversation reset) require `confirm: true`. Most also need `-y`/`--yes` in args to avoid a hanging prompt (`auth logout`, `clear`, `skill uninstall`, and `history --clear` are exceptions — CLI v0.7.3 does not support -y/--yes for those).
- **Start a new conversation**: `ask --new` is destructive (discards server-side conversation). Requires `confirm: true` and `-y`/`--yes`.
- **File overwrites**: `download`, `source fulltext -o <path>`, or `skill install` with `--force` overwrites workspace files — requires `confirm: true`.
- **Authentication** stays in NotebookLM CLI's own storage. Never pass cookies through Pi.

## JSON output

Add `--json` for machine-readable output. Key shapes:

- `ask --json`: `{"answer": "...", "references": [{"source_id": "...", "cited_text": "...", "citation_number": 1}], "conversation_id": "...", "turn_number": 1}`
- `list --json`: `{"notebooks": [...], "count": N}`
- `auth check --test --json`: `{"status": "ok", "checks": {...}}`
- `source list --json`: `{"sources": [...], "count": N}`
- `source wait --json`: `{"source_id": "...", "status": "ready", "status_code": 2}`

## Error routing

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| `exit 1` + auth error | Expired session | Run `notebooklm auth check --test --json`, re-login if needed |
| `exit 1` + rate limit | Quota exceeded | Wait and retry; generation is quota-limited |
| `exit 1` + source error | Source not ready | Wait with `source wait` before chat/generation |
| `exit 1` + generation fail | Content policy or invalid params | Adjust query or source content |
| `exit 2` | Timeout or CLI error | Increase `timeout_ms` or check args |
| CLI not found | Missing install | `uv tool install "notebooklm-py[browser]"` |
| `BrowserType.launch_persistent_context` | Missing Playwright browser | Auto-installed on first `notebooklm login`; if fails, run `uv tool run --from 'notebooklm-py[browser]' playwright install chromium` |
