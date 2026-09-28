# pi-extensions

Monorepo of Pi-native extension packages that register tools and skills directly
into the Pi coding agent, each in its own npm package under `@bacnh85/`.
Full version history lives in each package's package.json/CHANGELOG; per-package
detail lives in `pi-<name>/README.md`.

## Packages

| Package | Description |
|---------|-------------|
| **pi-router** | Connect to any OpenAI-compatible AI router via its /v1 API; `/login` for the key, `/router-config` panel, models auto-cached + refreshed. |
| **pi-commandcode** | Command Code's OpenAI-compatible Provider API; `/login`, `/commandcode-config` panel, models auto-cached. |
| **pi-classifier** | System One decision models (Jev) — `classify` tool, `/classifier-config`, opt-in Jev-gated permission auto-approve. |
| **pi-checkpoint** | Git-backed undo/redo — `/undo` rolls back a message AND its file changes. |
| **pi-cron** | Scheduled jobs — cron-style prompts fire into the live session; `cron export` emits crontab lines. |
| **pi-notify** | Desktop notifications + sounds on completion, errors, questions; cross-platform. |
| **pi-references** | External context roots — alias sibling dirs/repos as `@docs`/`@sdk`. |
| **pi-budget** | Spend cap enforcement — `--budget <usd>` aborts the agent at the cap. |
| **pi-init** | Guided AGENTS.md generation (`/init`). |
| **pi-permission** | Config-driven allow/ask/deny permission rules per tool with wildcards + external-dir boundary. |
| **pi-agy** | Google Antigravity CLI bridge for delegated implementation/refactors/tests. |
| **pi-fff** | FFF-powered fuzzy file and content search. |
| **pi-kicad** | KiCad CAD-design extension via the Konnect binary over a local HTTP daemon. |
| **pi-model-tools** | Tool-wrapping, argument repair, DeepSeek/GLM guidance, apply_patch diff tool, bash auto-background. |
| **pi-munin** | Munin long-term memory as native Pi tools (search/get/store/list/delete/share…). |
| **pi-evolve** | Trajectory self-learning — reflects on tool-call trajectories, persists learnings, injects them later. |
| **pi-selfskills** | Skill self-improvement — one `skill_manage` tool to patch/create skills with backups. |
| **pi-a2a** | A2A Protocol v1.0 bidirectional — distribute tasks to remote agents, expose Pi as an A2A agent, mDNS + gateway discovery, config panel. |
| **pi-config-panel** | Shared interactive config-panel kernel (library) powering the `/…-config` panels. |
| **pi-hub** | Installer CLI — `npx @bacnh85/pi-hub` browses the catalog and shells to `pi install`. |
| **pi-attachments** | Drops/pastes → `[[attach:name]]` chips + real image attachments. |
| **pi-notebooklm** | Google NotebookLM — notebooks, sources, chat, research, Studio artifacts via CLI bridge. |
| **pi-obsidian** | Obsidian vault integration. |
| **pi-advisor** | OMP-style automatic advisor — a second model reviews each turn and injects steering notes; on-demand consult. |
| **pi-plan** | Plan mode with read-only gating and plan → implement → verify → review workflow. |
| **pi-ponytail** | Lazy senior dev mode — YAGNI/stdlib-first discipline. Fork of DietrichGebert/ponytail. |
| **pi-review** | Isolated read-only code review. |
| **pi-rtk** | Bash command token rewriting through RTK. |
| **pi-serena** | Serena semantic code tools (symbols, references, diagnostics) via a persistent worker. |
| **pi-sub** | Subscription usage footer + `/context` breakdown. |
| **pi-subagent** | Isolated in-process subagents — parallel/chain, worktree isolation, background, role routing, herdr delegation. |
| **pi-web** | Unified web tools — search, extraction, crawl, screenshots/PDFs, real-browser interaction, research, image gen, chat. |
| **pi-windows-tools** | Windows-native shell/WSL/path tools + safety policy. |
| **pi-ux** | Anti-slop UI/UX discipline — DESIGN.md tokens, direction brief, render-inspect loop, ux_audit gate. |
| **pi-themes** | Pi TUI theme collection (pure themes, no extension code). |

## Repository Structure

One directory per package (`pi-<name>/`), plus `.github/workflows/ci.yml`
(single CI workflow), `.agents/skills/` (shared skills), and gitignored
`.env.local` (shared dev credentials). `pi-hub` is a standalone CLI, not
loaded by pi; `pi-config-panel` is a library dependency (no `pi` field);
`pi-themes` ships only `themes/*.json`.

## Package Structure

```
pi-<name>/
  package.json          # "pi": { "extensions": ["./extensions/index.ts"], "skills": ["./skills"] }
  extensions/index.ts   # default export: function(pi: ExtensionAPI) — .ts or .js
  extensions/package.json  # { "type": "module" }
  extensions/test/      # tests co-located with extension code
  skills/<name>/SKILL.md  # YAML frontmatter + markdown body
  CHANGELOG.md, README.md
```

Conventions: `files[]` includes source + CHANGELOG + README (Pi loads source
directly); `publishConfig.access: "public"`; extension code is plain JS or
TypeScript (TS when deps benefit from types); tests are unit-style — pi-ponytail
uses `node --test` (no framework), the rest mocha+tsx with `.mocharc.yml`.
Pure-theme packages (pi-themes) have no extensions/ or skills/ dirs.

## Common Patterns

- Extensions export a default function accepting `(pi: ExtensionAPI)`.
- Tools register with `pi.registerTool()` using TypeBox schemas.
- Commands register with `pi.registerCommand()`.
- Hooks (before_agent_start, tool_call, …) modify prompts or intercept calls.

## Testing

```bash
for d in pi-*/; do (cd "$d" && npm test) || echo "FAIL: $d"; done   # all packages (no root test script — loop per package)
cd pi-<name> && npm test      # one package — script is in its package.json
```

Runner styles: mocha+tsx runs via `cd extensions && npx mocha`;
plain-JS packages (pi-ponytail, pi-ux, pi-budget, pi-init, pi-permission,
pi-checkpoint, pi-notify, pi-references) use `node --test`;
pi-rtk also runs `npm pack --dry-run`; pi-themes validates themes + packaging.
Check the package's `test` script rather than guessing.

## CI/CD

`.github/workflows/ci.yml`: push to main / PRs / manual dispatch, Linux
`ubuntu-latest`; `dorny/paths-filter` builds a dynamic matrix so only affected
packages test; on main each changed package publishes to npm if its version
differs. Pi SDK peer caps: see `docs/pi-version-bumps.md` for the bump
procedure (including the nested-lockfile integrity backfill).

## Development discipline (ponytail)

Active by default — full ladder in the ponytail skill. Summary: YAGNI → reuse
what's in this codebase → stdlib → native platform → installed dependency →
one line → minimum code. Bug fix = root cause, not symptom. Mark deliberate
shortcuts with a `ponytail:` comment. Non-trivial logic leaves one runnable check.

## Tool guidelines for agents writing / modifying extensions

- TypeBox schemas go alongside the tool registration; `promptSnippet`/`promptGuidelines` feed model tool selection.
- File-mutation tools use `withFileMutationQueue` (from `@earendil-works/pi-coding-agent`) or lock by file path.
- Environment discovery: process env → cwd `.env.local` → cwd `.env` → Pi global config `.env.local` → `.env`.
- **Config placement rule**: non-secret config in `settings.json` under the extension's key; secrets in `auth.json` via `/login`. Never write secrets or a repo-controlled `.pi/settings.json` from extension code.
- **Interactive config panels** use `@bacnh85/pi-config-panel` (`openConfigPanel`, `row`, `makeOnAction`) — don't fork the TUI shell.
- Keep each package focused on one capability area.

## Adding a new package

1. Create `pi-<name>/` with the standard layout above (`publishConfig.access: "public"`, peer/dev deps, `files[]`).
2. Add a CI matrix entry in `.github/workflows/ci.yml` (paths-filter + `all` array with test command + typecheck if TS).
3. Add a row to the package table here and in `README.md`.

### Agent-specific guidelines

- **Serena** is the primary code-navigation tool — prefer it over grep for symbol/reference searches.
- **Subagents** (scout/tester) parallelize read-heavy exploration.
- **Munin** stores/reuses durable knowledge — `munin_search` before non-trivial work.
- **Ponytail** runs on every change.
- Lockfiles must be refreshed (not just `npm ci`) when the Pi SDK version changes.

## Release process

See `docs/release.md` — bump the version, merge to main, publish workflow handles npm.
