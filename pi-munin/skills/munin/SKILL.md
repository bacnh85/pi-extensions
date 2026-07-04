---
name: munin
description: Use Munin long-term memory before non-trivial repo work, bug fixes with recurring symptoms, architecture/dependency/setup changes, and when storing durable verified knowledge for future sessions. Search, retrieve, verify, list, store, version, roll back, or share project knowledge across sessions. Use munin_search for pre-work context, munin_store for post-work storage. Use when the user mentions memory, recall, remember, past work, previously, store this, document this, or when work could benefit from prior project knowledge.
---

# Munin

Munin is the canonical memory system for Pi. Use it for all memory operations — project-local and cross-project.

Use the Munin Pi extension tools to recover and preserve verified project knowledge through native Pi-native tool calls. Memory results are leads, not authority: verify them against the current repository, docs, command output, or user-provided facts before relying on them.

## How It Works

1. The `pi-munin` extension provides native tools: `munin_search`, `munin_get`, `munin_store`, `munin_list`, `munin_recent`, `munin_delete`, `munin_capabilities`.
2. Credentials are loaded from `.env.local` / `.env` or environment variables (`MUNIN_API_KEY`, `MUNIN_PROJECT`).
3. Print readable output by default, or raw JSON via tool details.
4. Store only durable knowledge that is verified and useful in a future session.

## Quick Start

**Pre-work: search context:**
```
munin_search query="auth refresh token timeout" tags="type:bug-fix,domain:auth" topK=5
```

**Post-work: store knowledge:**
```
munin_store
  key="bug-fix/auth-refresh-timeout"
  title="Auth refresh timeout fix"
  content="Conclusion: The auth refresh timeout was caused by missing timeout fallback...\n\nWhy it matters: Future auth work should avoid this pattern...\n\nEvidence/verification: Verified with test_auth_refresh.py passing...\n\nAnchors: src/auth.ts:42, AuthService.refreshToken"
  tags="type:bug-fix,domain:auth"
```

**Targeted operations:**
```
munin_search query="cache policy" tags="type:decision" topK=5
munin_get key="architecture/cache-policy"
munin_store key="setup/new-db-migration" title="..." content="..." tags="type:fact,domain:infra"
munin_list limit=20
munin_recent limit=10
```

## Workflow: Before Non-Trivial Work

1. **Assess need**: Is this a new area, bug fix, architecture change, or dependency update? If yes, search first.
2. **Search**: Use `munin_search` with focused 4-8 word queries built from exact phrases, capitalized entities, subsystem names, file paths, error codes, and dependency names.
   ```
   munin_search query="ERR_STALE_PROTOCOL munin" topK=5
   munin_search query="auth token refresh bug" tags="type:bug-fix" topK=5
   ```
3. **Verify**: Read promising memories with `munin_get`. Cross-check against current repository evidence.
4. **Act**: Proceed with the task, incorporating verified context.

## Workflow: After Work

1. **Assess value**: Did this session establish verified knowledge a future session would need?
2. **Store**: Use `munin_store` with structured content:
   - **Conclusion**: The core finding or decision.
   - **Why it matters**: Why a future session should care.
   - **Evidence/verification**: Tests, files, commands that confirm this.
   - **Anchors**: Durable file/symbol paths that won't change.
3. **Validate tags**: Ensure at least one `type:` (decision, bug-fix, fact, dependency) AND one `domain:` (auth, frontend, backend, infra, memory) tag.

## Tag Discipline

| Category | Examples | Required |
|----------|----------|----------|
| `type:` | decision, bug-fix, fact, dependency | Yes, at least one |
| `domain:` | auth, frontend, backend, infra, memory | Yes, at least one |
| `status:` | active, deprecated, experimental | Optional |
| `priority:` | high, medium, low | Optional |

## Search Query Quality

Munin scores results across 6 signals: keyword, semantic, quoted-phrase boost (+0.25), named-entity boost (+0.15), recency (≤+0.10), pinned (+0.10).

| Technique | How | Boost |
|-----------|-----|-------|
| Quoted phrases | Wrap exact strings in double quotes: `"JWT TTL"` | +0.25 |
| Named entities | Capitalize entity names: `Stripe`, `Munin`, `React` | +0.15 |
| Multi-word | Use 4-8 word queries for better semantic matching | — |

**DO NOT use single-word queries** unless the term is a genuinely rare error code. Single common words return noise because they lack discriminative signal.

Examples:
- ❌ `auth` — single word, only semantic+keyword signals
- ✅ `"JWT TTL" auth refresh timeout` — quoted phrase + 2 keywords
- ✅ `"EAI_AGAIN" MongoDB Atlas connection drop` (with `tags="type:bug-fix"`)

## Tool Selection

| Tool | When to Use |
|------|-------------|
| `munin_search` | Targeted search with specific filters before work. |
| `munin_get` | Retrieve full content of a specific memory by key. |
| `munin_store` | Store verified knowledge with tag validation. |
| `munin_list` / `munin_recent` | Browse or audit what is stored. |
| `munin_delete` | Only when user explicitly requests removal. |
| `munin_capabilities` | Check what server features are available. |

## Present Results to User

When memory affects the task, summarize briefly:

```
I found relevant memory: <key> — <one-line conclusion>. I verified it against <repo file or command> before using it.
```

When storing memory, report only non-sensitive metadata:

```
Stored memory `<key>` with tags `<tags>`.
```

Do not show secrets, credential values, private keys, tokens, or sensitive connection strings.

## What to Store

Store one verified concept per memory:

- Architecture or product decisions and rationale.
- Recurring bug symptoms, root causes, fixes, and verification.
- Stable setup facts, conventions, constraints, and dependency choices.
- Durable user/project preferences when they materially guide work.
- Cross-reference related memories by mentioning their keys in `content` (e.g., `See also: architecture/cache-policy`). This enables Munin's semantic search to surface related knowledge together.

Do not store:

- Secrets, credentials, tokens, private keys, or connection strings.
- Raw logs, transient task progress, temporary TODOs, or unverified guesses.
- Information already trivial to derive from repository files.

## References

- Read `references/workflow-patterns.md` when choosing between search/get/store workflows.

## Examples

**Pre-work search for a bug:**
```
munin_search query="auth refresh timeout error" tags="type:bug-fix,domain:auth"
→ I found relevant memory: bug-fix/auth-refresh-timeout — Missing fallback caused 500ms timeout. Verified against src/auth.ts before using it.
```

**Post-work store:**
```
munin_store
  key="architecture/cache-policy"
  title="Cache policy decision"
  content="Conclusion: Use LRU with 1h TTL for API responses, no-cache for auth tokens.\n\nWhy it matters: Prevents stale data and reduces backend load.\n\nEvidence/verification: Benchmarked with k6: 40% reduction in DB queries.\n\nAnchors: src/cache.ts, CachePolicy class"
  tags="type:decision,domain:backend"
```

## Troubleshooting

- **Missing extension**: Install `pi-munin` extension.
- **Missing credentials**: Set `MUNIN_API_KEY` and `MUNIN_PROJECT` in `.env.local` or environment.
- **Tag validation failed**: Ensure at least one `type:` and one `domain:` tag. Check spelling.
- **Single-word search queries return noise**: Use 4-8 word queries with at least one quoted phrase or capitalized entity name. See "Search Query Quality" section above.
- **No results**: Try broader queries, fewer tags, or `munin_list` to see what exists.

## Relationship to Other Skills

- **`memory` skill**: Universal skill for any agent (not just Pi). Uses the Munin CLI directly. Use when the `pi-munin` extension is not available.
- **`pi-munin` extension**: Pi-native tools. More token-efficient, no skill instruction overhead. Preferred when available.
