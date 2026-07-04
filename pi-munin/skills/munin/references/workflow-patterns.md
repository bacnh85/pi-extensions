# Munin Workflow Patterns

## Pre-work search

Use `munin_search` to find relevant memories before non-trivial work:

1. Build a focused 4-8 word query from exact errors, subsystems, file paths, dependency names, or public symbols.
2. Add tags when they clearly reduce noise, for example `type:bug-fix,domain:auth`.
3. Treat results as leads. Verify against current repository files, tests, docs, or user-provided facts.
4. Retrieve full content with `munin_get` when a search result looks promising.

## Post-work store

Use `munin_store` for one durable concept established by the session. Include structured content with:

- Conclusion
- Why it matters
- Evidence / verification
- Durable anchors
- Tags with at least one `type:` and one `domain:`
