# pi-extensions

Monorepo of Pi-native extension packages that register tools and skills directly
into the Pi coding agent, each in its own npm package under `@bacnh85/`.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| **pi-router** | 1.0.1 | Connect to any OpenAI-compatible AI router (9router, omniroute, …) via its /v1 API; API key via built-in /login, URL in settings.json, models auto-cached in models-store.json. |
| **pi-chatgpt-web** | 0.2.0 | ChatGPT web-tier providers via self-hosted OpenAI-compatible bridges — chat-only `chatgpt-web` (chatgpt2api) + agentic `codex-web` (codex-proxy, tool-capable). No Plus subscription. |
| **pi-commandcode** | 0.1.0 | Connect to Command Code's OpenAI-compatible Provider API; uses built-in `/login` for API-key setup. |
| **pi-checkpoint** | 0.1.0 | Git-backed undo/redo — snapshots file state per turn into a dedicated ref namespace so `/undo` rolls back a message AND its file changes. |
| **pi-notify** | 0.1.1 | Desktop notifications and sounds — fires on task completion, errors, and questions; cross-platform (macOS/Linux/Windows + terminal OSC). |
| **pi-references** | 0.1.1 | External context roots — alias sibling dirs or git repos as `@docs`/`@sdk`; auto-clones repos and injects descriptions into agent context. |
| **pi-budget** | 0.1.2 | Spend cap enforcement — `--budget <usd>` aborts the agent at the cap; companion to pi-sub (render vs enforce). |
| **pi-init** | 0.1.0 | Guided AGENTS.md generation — `/init` scans the repo and generates/updates AGENTS.md with build/test/lint commands, architecture, and conventions. |
| **pi-permission** | 0.1.2 | Granular permission system — config-driven allow/ask/deny rules per tool with wildcard patterns, external-directory boundary, and a doom-loop guard. |
| **pi-agy** | 0.3.1 | Google Antigravity CLI bridge for delegated implementation, scaffolding, refactors, and test generation. |
| **pi-fff** | 0.7.9 | FFF-powered fuzzy file and content search for Pi. |
| **pi-kicad** | 0.1.3 | KiCad CAD-design extension — drive schematic capture and PCB layout via the Konnect binary over a local HTTP daemon (no MCP SDK). |
| **pi-model-tools** | 0.5.5 | Unified tool-wrapping, argument repair, reasoning management, DeepSeek V4 guidance + Super Power Mode, defensive leak-cleaning, edit mismatch repair, and a Codex-style apply_patch diff tool. |
| **pi-munin** | 0.5.2 | Munin long-term memory as eight native Pi tools for search, retrieval, storage, listing, deletion, capabilities, and confirmed cross-project sharing. |
| **pi-evolve** | 0.3.1 | Trajectory-based self-learning loop — captures tool-call trajectories, reflects to extract learnings, persists to Munin or local JSONL, injects recent learnings into future sessions. |
| **pi-a2a** | 0.6.3 | A2A Protocol v1.0 bidirectional — Pi distributes tasks to remote agents (Hermes, ADK, LangChain, any A2A peer), exposes itself as an A2A-callable agent, self-declares for local session discovery (file registry + enriched Agent Card + mDNS), registers with **multiple a2a-switchboard gateways** (`discovery.gateways`), shows inbound task activity in the host TUI, and has an interactive config panel. |
| **pi-notebooklm** | 0.1.8 | Google NotebookLM — notebooks, sources, chat, research, and Studio artifacts via CLI bridge. |
| **pi-obsidian** | 0.8.13 | Obsidian vault integration for Pi. |
| **pi-plan** | 0.10.4 | Plan mode with read-only gating and plan → implement → verify → review workflow; fallback model chain on overload. |
| **pi-ponytail** | 0.1.10 | Lazy senior dev mode — YAGNI/stdlib-first coding discipline. Fork of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). |
| **pi-review** | 0.2.8 | Isolated read-only code review with corrected same-session fallback. |
| **pi-rtk** | 0.1.12 | Bash command token rewriting through RTK. |
| **pi-serena** | 0.9.6 | Serena semantic code tools (find/replace/rename symbols, LSP diagnostics) through a persistent TypeScript worker with Python bridge. |
| **pi-sub** | 0.1.25 | Subscription usage footer for OpenAI Codex, OpenCode Go, and Z.ai. |
| **pi-themes** | 0.1.1 | Ayu-based theme collection (dark, mirage, light) for the Pi TUI — pure-themes package (no extension code). |
| **pi-subagent** | 0.15.0 | Isolated in-process subagents with parallel/chain modes, inspectable threads, git worktree isolation (`sandbox: worktree`), live progress widget, and background mode. |
| **pi-web** | 0.5.7 | Unified web search (SearXNG, Brave, Firecrawl), content extraction (JSDOM, Firecrawl, Crawl4AI), site mapping/crawling, page screenshots/PDFs. |
| **pi-ux** | 0.4.4 | Anti-slop UI/UX design discipline — anchors a lintable DESIGN.md, ships medium-tuned presets (Web/Mobile) so the agent stays unblocked when DESIGN.md is missing, runs deterministic slop-audit gates (APCA contrast + tokens + states + slop tells), works with text-only models. |
| **pi-windows-tools** | 0.5.2 | Windows-specific tools for Pi. |

## Repository Structure

```
pi-extensions/
  pi-agy/               # TS extension + skill for Antigravity CLI bridge
  pi-notebooklm/        # TS extension + skill for NotebookLM CLI bridge
  pi-ponytail/          # JS extension + hooks + 6 sub-skills
  pi-serena/            # TS extension + worker + Python bridge
  pi-ux/                # JS extension + hook + skill for anti-slop UI/UX design discipline
  pi-munin/             # TS extension + lib/helpers + skill + references
  pi-evolve/            # TS extension + lib/buffer+store+inject + skill for trajectory self-learning
  pi-a2a/               # TS extension + lib (protocol/client/server/config/security/persistence/registry/mdns/discovery/activity/config-panel) for A2A Protocol v1.0
  pi-plan/              # TS extension for plan mode + workflow integration
  pi-subagent/          # TS extension for isolated SDK subagents
  pi-review/            # TS extension for isolated/local code review
  pi-fff/               # TS extension for FFF-powered find/grep/autocomplete
  pi-rtk/               # TS extension for RTK bash command rewriting
  pi-model-tools/        # TS extension for unified tool-wrapping + DeepSeek guidance + Super Power Mode (DeepSeek V4 + GLM)
   pi-router/            # TS extension to connect to any OpenAI-compatible AI router.
   pi-chatgpt-web/       # TS extension: ChatGPT web-tier provider via self-hosted chatgpt2api bridge.
  pi-commandcode/       # TS extension for Command Code Provider API.
  pi-budget/            # JS extension for spend-cap enforcement (--budget <usd>).
  pi-sub/               # TS extension for subscription usage footer
  pi-themes/            # JSON theme files — pure-themes package (no extension code)
  pi-init/              # JS extension for guided AGENTS.md generation (/init)
  pi-permission/        # JS extension for config-driven allow/ask/deny permission rules
  pi-checkpoint/        # JS extension for git-backed /undo /redo tied to turns
  pi-notify/            # JS extension for desktop notifications + sounds
  pi-references/        # JS extension for external context roots (@docs, @sdk)
  .github/workflows/    # ci.yml (matrix, GitHub-hosted runners)
  .agents/skills/       # shared skills (skill-creator)
  .env.local            # shared dev credentials (gitignored)
  .gitignore            # .agents/ and .env.*
```

## Package Structure

Every package follows the same layout:

```
pi-<name>/
  package.json          # name, version, files[], scripts, pi field, keywords
  README.md             # docs, install, commands, configuration
  CHANGELOG.md          # version history and release entries
  .gitignore            # node_modules/ and .env.*

  extensions/           # Pi extension entrypoint and supporting modules
    index.ts            # default export: function(pi: ExtensionAPI) — .ts or .js
    package.json        # { "type": "module" }
    test/               # tests co-located with extension code
      *.test.ts         # .ts or .js, matching extension entrypoint

  skills/               # skill sub-skills, each in its own directory

  # OR (pure-themes package like pi-themes): themes/*.json + previews/ + LICENSE,
  # no extensions/ or skills/ dirs. pi.themes in package.json points at ./themes.
    <name>/SKILL.md     # YAML frontmatter + markdown body

  hooks/                # (optional) shared modules for extensions + skills
    *.ts                # .ts or .js, matching extension entrypoint
```

**Key conventions:**

- `package.json` root: `"pi": { "extensions": ["./extensions/index.ts"], "skills": ["./skills"] }` — entrypoint extension matches the file (`.ts` or `.js`)
- `files` in package.json includes `"CHANGELOG.md"`, `"README.md"`, source files, etc. (Pi loads source directly).
- Every package has a standalone `CHANGELOG.md` for user-facing release history.
- `publishConfig.access: "public"` for scoped packages.
- `extensions/package.json` is just `{ "type": "module" }` to opt into ESM.
- Extension code is **plain JS** (pi-ponytail pattern) or **TypeScript** (pi-serena, pi-web, pi-munin) — use TS when the package has sdks/deps that benefit from types.
- Tests live in `extensions/test/` — pi-ponytail uses `node --test` (no framework); others use mocha+tsx.
- Skills in `skills/<name>/SKILL.md` with YAML frontmatter — one directory per skill.
- Root AGENTS.md is the package-level version of the convention file (see pi-ponytail/AGENTS.md).

## Common Patterns

- Extensions export a default function accepting `(pi: ExtensionAPI)`.
- Tools are registered with `pi.registerTool()` using TypeBox schemas.
- Commands register with `pi.registerCommand()`.
- Hooks (before_agent_start, tool_call, etc.) modify system prompts or intercept tool calls.

## Testing

```bash
# All packages
npm test

# Individual package
cd pi-<name> && npm test

# Test runners (follow package conventions):
# pi-agy:        cd extensions && mocha                (mocha + tsx)
# pi-notebooklm: cd extensions && mocha                (mocha + tsx)
# pi-ponytail:   node --test extensions/test/*.test.js (no framework, plain JS)
# pi-ux:        node --test extensions/test/*.test.js (no framework, plain JS)
# pi-budget:    node --test extensions/test/*.test.js (no framework, plain JS)
# pi-init:       node --test extensions/test/*.test.js (no framework, plain JS)
# pi-permission: node --test extensions/test/*.test.js (no framework, plain JS)
# pi-checkpoint: node --test extensions/test/*.test.js (no framework, plain JS)
# pi-notify:     node --test extensions/test/*.test.js (no framework, plain JS)
# pi-references: node --test extensions/test/*.test.js (no framework, plain JS)
# pi-evolve:     cd extensions && npx mocha                (mocha + tsx)
# pi-a2a:        cd extensions && mocha                    (mocha + tsx)
# pi-serena:     cd extensions && mocha                (mocha + tsx)
# pi-web:        cd extensions && mocha                (mocha + tsx, ESM)
# pi-munin:      npx mocha                             (mocha + tsx)
# pi-plan:       cd extensions && mocha                (mocha + tsx)
# pi-subagent:   cd extensions && mocha                (mocha + tsx)
# pi-review:     cd extensions && mocha                (mocha + tsx)
# pi-rtk:        npm pack --dry-run                    (packaging check)
# pi-sub:        npm pack --dry-run                    (packaging check)
# pi-themes:     npm pack --dry-run                    (packaging check; pure-themes, no extension code)
# pi-router:     node --import tsx --test extensions/test/unit.test.ts (node:test + tsx)
# pi-chatgpt-web: node --import tsx --test extensions/test/unit.test.ts (node:test + tsx)
# pi-commandcode: node --import tsx --test extensions/test/*.test.ts (node:test + tsx)
```

Test files use unit-test style (no fixture frameworks, consistent with ponytail
rules for simplicity). Config goes in `.mocharc.yml` (`tsx` require + `test/**/*.test.ts`
spec). pi-ponytail uses `node --test` with no mocha or tsx dependency at all.

## CI/CD

A single `.github/workflows/ci.yml` workflow runs on GitHub-hosted runners:

- **Triggers:** push to `main`, pull requests, and manual `workflow_dispatch`.
- **Runner matrix:** Linux on `ubuntu-latest` for all packages; `windows-latest` for `pi-windows-tools`.
- **Changed-package detection:** `dorny/paths-filter` builds a dynamic matrix so only affected packages are tested.
- **Test commands:** pi-ponytail uses `node --test`; pi-rtk and pi-sub use `npm pack --dry-run`; all others use `npm ci && npm test` (with `npm run typecheck` for TypeScript packages).
- **Publishing:** On push to `main`, each changed package is published to npm if its version differs from the registry version.

### Pi version bumps

After each Pi minor release, verify extensions against the new SDK:

1. Check the Pi CHANGELOG for "Breaking Changes" that affect extension APIs (TypeBox imports, ExtensionAPI exports, etc.).
2. Widen peer caps `<0.x.0` → `<0.(x+1).0` in `pi-plan`, `pi-sub`, and `pi-subagent` (the three packages with bounded peers).
3. Bump their devDeps from `^0.x.0` to `^0.(x+1).0` (also `pi-review`'s devDep).
4. Patch-version-bump + CHANGELOG the three capped packages; `pi-review` is devDep-only — no version bump needed.
5. Refresh lockfiles in all packages so `npm ci` installs the new SDK.
6. Run tests and typecheck; verify the installed SDK version per package.

## Development discipline (ponytail)

This monorepo uses **ponytail** — lazy senior dev mode. The ladder below runs on every change, not just at audit time.

### The ladder

Stop at the first rung that holds:

1. **YAGNI** — Does this need to exist at all? Speculative need = skip, say so. If a feature request describes a symptom and the root cause is already fixed elsewhere, don't build it.
2. **Already in this codebase?** — A helper, util, type, or pattern that already lives here → reuse it. Look before you write.
3. **Stdlib does it?** — Use it. `fs.readFileSync`, `URL`, `Intl`, `Set`, `Map` — Node.js stdlib covers most needs.
4. **Native platform feature covers it?** — CSS over JS lib, HTML input types over picker components, DB constraints over app-level validation.
5. **Already-installed dependency?** — Use it. Never add a new one for what a few lines can do.
6. **One line?** — One line.
7. **Only then:** minimum code that works.

### Enforce between changes

Before adding the *next* thing, re-read what you just built and ask: *what here is unnecessary?* If you can delete something without breaking tests, delete it. If a simplification makes the diff shorter, ship the simplification.

**Bug fix = root cause, not symptom.** Fix it once where all callers route through, not patching only the path the ticket names.

### Mark shortcuts

Mark deliberate simplifications with a `ponytail:` comment so the shortcut reads as intent, not ignorance:
```typescript
// ponytail: global lock, per-account locks if throughput matters
```

### Tests

Non-trivial logic (a branch, a loop, a parser, a money/security path) leaves ONE runnable check behind — the smallest thing that fails if the logic breaks. Trivial one-liners need no test.

## Tool guidelines for agents writing / modifying extensions

- TypeBox schemas go alongside the tool registration (see existing `parameters`).
- `promptSnippet` and `promptGuidelines` are used by the model for tool selection.
- Shared control params (`project`, `context`, `timeout_ms`) are extracted via
  `stripControlParams()` (pi-serena) or handled per-tool (pi-web, pi-munin).
- File-mutation tools use `withFileMutationQueue` (from `@earendil-works/pi-coding-agent`)
  or lock by file path to avoid concurrent edits.
- Environment discovery follows: process env → cwd `.env.local` → cwd `.env` →
  Pi global config `.env.local` → `.env`. Implemented in each package's config module.
- Skills use SKILL.md with YAML frontmatter under `skills/<name>/SKILL.md`.
- Never hardcode API URLs/keys; always load through config modules.
- Keep each package focused on one capability area — tools, commands, skills.

## Adding a new package

To add a new extension package to this monorepo:

1. Create `pi-<name>/` with the standard layout:
   - `package.json` — set `"pi": { "extensions": ["./extensions/index.ts"] }`, `"publishConfig.access": "public"`, appropriate peer/dev deps, `files[]` including source files + `CHANGELOG.md` + `README.md`.
   - `extensions/index.ts` — default export `(pi: ExtensionAPI) => { /* register tools/commands/hooks */ }`.
   - `extensions/package.json` — `{ "type": "module" }` for ESM support.
   - `extensions/test/*.test.ts` — tests co-located with the extension code.
   - `skills/<name>/SKILL.md` — optional skill with YAML frontmatter.
   - `CHANGELOG.md` — one per package with version history.
2. Add the package to the CI matrix in `.github/workflows/ci.yml` (paths-filter entry + `all` array entry with the appropriate test command + typecheck step if TypeScript).
3. Add the package row to the table in this file and in `README.md`.

### Agent-specific guidelines

- **Serena** is the primary code-navigation tool for symbols/references — prefer it over grep for code searches.
- **Subagents** (scout for recon, tester for verification) can parallelize read-heavy exploration.
- **Munin** stores/reuses durable knowledge across sessions — use `munin_search` before non-trivial work.
- **Ponytail** is active by default — apply the ladder (YAGNI → stdlib → native → dependency → one line → minimum code).
- Lockfiles must be refreshed (not just `npm ci`) when the Pi SDK version changes — verify installed SDK version per package before trusting test results.

## Release Process

1. Update `version` in the package's `package.json`.
2. Merge to main → publish workflow auto-publishes to npm if version differs.
3. `@bacnh85/` scoped packages, public access.
