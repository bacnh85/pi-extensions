# pi-extensions

Monorepo of Pi-native extension packages that register tools and skills directly
into the Pi coding agent, each in its own npm package under `@bacnh85/`.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| **pi-ponytail** | 0.1.1 | Lazy senior dev mode — YAGNI/stdlib-first coding discipline. Fork of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). |
| **pi-serena** | 0.8.0 | Serena semantic code tools (find/replace/rename symbols, LSP diagnostics) through a persistent TypeScript worker with Python bridge. |
| **pi-web** | 0.4.3 | Unified web search (SearXNG, Brave, Firecrawl), content extraction (JSDOM, Firecrawl, Crawl4AI), site mapping/crawling, page screenshots/PDFs. |
| **pi-munin** | 0.3.0 | Munin long-term memory as native Pi tools (search, store, recall, capture, summarize, share, export, E2EE). |

## Repository Structure

```
pi-extensions/
  pi-ponytail/          # JS extension + hooks + 6 sub-skills
  pi-serena/            # TS extension + worker + Python bridge
  pi-web/               # TS extension + 9 lib modules + skill
  pi-munin/             # TS extension + lib/helpers + skill + references
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
    index.js            # default export: function(pi: ExtensionAPI)
    package.json        # { "type": "module" }
    test/               # tests co-located with extension code
      *.test.js

  skills/               # skill sub-skills, each in its own directory
    <name>/SKILL.md     # YAML frontmatter + markdown body

  hooks/                # (optional) shared modules for extensions + skills
    *.js
```

**Key conventions:**

- `package.json` root: `"pi": { "extensions": ["./extensions/index.js"], "skills": ["./skills"] }`
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
# pi-ponytail: node --test extensions/test/*.test.js   (no framework, plain JS)
# pi-serena:   cd extensions && mocha                  (mocha + tsx)
# pi-web:      cd extensions && mocha                  (mocha + tsx, ESM)
# pi-munin:    npx mocha                               (mocha + tsx)
```

Test files use unit-test style (no fixture frameworks, consistent with ponytail
rules for simplicity). Config goes in `.mocharc.yml` (`tsx` require + `test/**/*.test.ts`
spec). pi-ponytail uses `node --test` with no mocha or tsx dependency at all.

## CI/CD

Two GitHub Actions workflows in `.github/workflows/`:

- **test.yml** — runs on push to main and PRs. Matrix across all 4 packages.
  pi-ponytail uses `node --test` directly; others use `npm ci && npm test`.
- **publish.yml** — runs on push to main. Checks each package's `package.json`
  version against the npm registry and publishes if different.

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
