---
name: munin
description: Use Munin long-term memory before non-trivial repo work, bug fixes with recurring symptoms, architecture/dependency/setup changes, and when storing durable verified knowledge for future sessions. Search, retrieve, verify, list, store, or share project knowledge across sessions. Use munin_search for pre-work context, munin_store for post-work storage. Use when the user mentions memory, recall, remember, past work, previously, store this, document this, or when work could benefit from prior project knowledge.
---

# Munin

Munin is the canonical memory system for Pi. Use it for all memory operations — project-local and cross-project.

Use the Munin Pi extension tools to recover and preserve verified project knowledge through native Pi-native tool calls. Memory results are leads, not authority: verify them against the current repository, docs, command output, or user-provided facts before relying on them.

## How It Works

1. The `pi-munin` extension provides native tools: `munin_search`, `munin_get`, `munin_store`, `munin_list`, `munin_recent`, `munin_delete`, `munin_capabilities`, `munin_share`.
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

## Tag Discipline

| Category | Examples | Required |
|----------|----------|----------|
| `type:` | decision, bug-fix, fact, dependency | Yes, at least one |
| `domain:` | auth, frontend, backend, infra, memory | Yes, at least one |
| `status:` | active, deprecated, experimental | Optional |
| `priority:` | high, medium, low | Optional |

## Search Query Quality

Use **4-8 word queries** with **quoted phrases** (`"JWT TTL"`) and **capitalized entity names** (`Stripe`, `Munin`). Quoted phrases get +0.25 score boost; named entities get +0.15. **DO NOT use single-word queries** — they return noise. Example: ✅ `"EAI_AGAIN" MongoDB Atlas connection drop` — ❌ `auth`.

## Tool Selection

| Tool | When to Use |
|------|-------------|
| `munin_search` | Targeted search with specific filters before work. |
| `munin_get` | Retrieve full content of a specific memory by key. |
| `munin_store` | Store verified knowledge with tag validation. |
| `munin_list` / `munin_recent` | Browse or audit what is stored. |
| `munin_delete` | Only when user explicitly requests removal. |
| `munin_capabilities` | Check what server features are available. |
| `munin_share` | Share memories across projects. |



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

## Workflow

**Pre-work**: `munin_search` with 4-8 word query + tags → `munin_get` promising results → verify against repo. **Post-work**: `munin_store` with conclusion + why + evidence + anchors + tags.

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


