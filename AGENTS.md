# pi-extensions

Monorepo of Pi-native extension packages that register tools and skills directly
into the Pi coding agent, each in its own npm package under `@bacnh85/`.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| **pi-agy** | 0.2.0 | Google Antigravity CLI bridge for delegated implementation, scaffolding, refactors, and test generation. |
| **pi-deepseek-tools** | 0.12.4 | DeepSeek V4 tool calling fixes, argument repair, reasoning cleanup, thinking level compatibility, Super Power Mode. |
| **pi-notebooklm** | 0.1.0 | Google NotebookLM — notebooks, sources, chat, research, and Studio artifacts via CLI bridge. |
| **pi-ponytail** | 0.1.4 | Lazy senior dev mode — YAGNI/stdlib-first coding discipline. Fork of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). |
| **pi-serena** | 0.8.3 | Serena semantic code tools (find/replace/rename symbols, LSP diagnostics) through a persistent TypeScript worker with Python bridge. |
| **pi-web** | 0.5.3 | Unified web search (SearXNG, Brave, Firecrawl), content extraction (JSDOM, Firecrawl, Crawl4AI), site mapping/crawling, page screenshots/PDFs. |
| **pi-munin** | 0.4.3 | Munin long-term memory as native Pi tools (search, store, recall, capture, summarize, share, export, E2EE). |
| **pi-plan** | 0.5.0 | Plan mode with read-only gating and plan → implement → verify → review workflow. |
| **pi-subagent** | 0.5.0 | Isolated in-process subagents with parallel/chain modes and inspectable threads. |
| **pi-review** | 0.2.0 | Isolated read-only code review with corrected same-session fallback. |
| **pi-fff** | 0.7.2 | FFF-powered fuzzy file and content search for Pi. |
| **pi-obsidian** | 0.6.0 | Obsidian vault integration for Pi. |
| **pi-rtk** | 0.1.8 | Bash command token rewriting through RTK. |
| **pi-sub** | 0.1.10 | Subscription usage footer for OpenAI Codex, OpenCode Go, and Z.ai. |
| **pi-windows-tools** | 0.2.0 | Windows-specific tools for Pi. |

## Repository Structure

```
pi-extensions/
  pi-agy/               # TS extension + skill for Antigravity CLI bridge
  pi-notebooklm/        # TS extension + skill for NotebookLM CLI bridge
  pi-ponytail/          # JS extension + hooks + 6 sub-skills
  pi-serena/            # TS extension + worker + Python bridge
  pi-web/               # TS extension + 9 lib modules + skill
  pi-munin/             # TS extension + lib/helpers + skill + references
  pi-plan/              # TS extension for plan mode + workflow integration
  pi-subagent/          # TS extension for isolated SDK subagents
  pi-review/            # TS extension for isolated/local code review
  pi-fff/               # TS extension for FFF-powered find/grep/autocomplete
  pi-rtk/               # TS extension for RTK bash command rewriting
  pi-sub/               # TS extension for subscription usage footer
  .github/workflows/    # publish.yml + test.yml (matrix across packages)
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
  .gitignore            # node_modules/ and .env.*

  extensions/           # Pi extension entrypoint and supporting modules
    index.ts            # default export: function(pi: ExtensionAPI) — .ts or .js
    package.json        # { "type": "module" }
    test/               # tests co-located with extension code
      *.test.ts         # .ts or .js, matching extension entrypoint

  skills/               # skill sub-skills, each in its own directory
    <name>/SKILL.md     # YAML frontmatter + markdown body

  hooks/                # (optional) shared modules for extensions + skills
    *.ts                # .ts or .js, matching extension entrypoint
```

**Key conventions:**

- `package.json` root: `"pi": { "extensions": ["./extensions/index.ts"], "skills": ["./skills"] }` — entrypoint extension matches the file (`.ts` or `.js`)
- `files` in package.json lists everything (not just `dist/` — Pi loads source directly).
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
# pi-serena:     cd extensions && mocha                (mocha + tsx)
# pi-web:        cd extensions && mocha                (mocha + tsx, ESM)
# pi-munin:      npx mocha                             (mocha + tsx)
# pi-plan:       cd extensions && mocha                (mocha + tsx)
# pi-subagent:   cd extensions && mocha                (mocha + tsx)
# pi-review:     cd extensions && mocha                (mocha + tsx)
# pi-rtk:        npm pack --dry-run                    (packaging check)
# pi-sub:        npm pack --dry-run                    (packaging check)
```

Test files use unit-test style (no fixture frameworks, consistent with ponytail
rules for simplicity). Config goes in `.mocharc.yml` (`tsx` require + `test/**/*.test.ts`
spec). pi-ponytail uses `node --test` with no mocha or tsx dependency at all.

## CI/CD

Two GitHub Actions workflows in `.github/workflows/`:

- **test.yml** — runs on push to main and PRs. Matrix across all 15 packages.
  pi-ponytail uses `node --test` directly, pi-rtk and pi-sub use `npm pack --dry-run`, others use `npm ci && npm test`.
- **publish.yml** — runs on push to main. Checks each package's `package.json`
  version against the npm registry and publishes if different.

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

## Release Process

1. Update `version` in the package's `package.json`.
2. Merge to main → publish workflow auto-publishes to npm if version differs.
3. `@bacnh85/` scoped packages, public access.
