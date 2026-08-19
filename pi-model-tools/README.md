# @bacnh85/pi-model-tools

**Unified model-family support for Pi** — tool-wrapping, argument repair,
reasoning management, defensive leak-cleaning, DeepSeek V4 selection guidance,
and Super Power Mode, all in one extension. Currently supports **DeepSeek V4**
and **GLM** (GLM-4.5 through GLM-5.3) from any provider.

This is the **single source of tool-wrapping** for these families. It registers
the 7 built-in Pi tools (read, write, edit, grep, find, ls, bash) exactly once
and routes behavior by detected model family.

> **Merged package (v0.2.0).** This package now absorbs the former
> `pi-deepseek-tools` and `pi-glm` extensions. Those packages are deprecated;
> their last published versions remain on npm but receive no further updates.
> All configuration is unified under the `PI_MODEL_TOOLS_*` namespace (the old
> `PI_DEEPSEEK_TOOLS_*` / `PI_GLM_*` names are no longer read).

## Why one package

Pi's `ExtensionAPI` cannot conditionally register tools — `registerTool()`
runs at load time, conflicts are detected post-load (uncatchable), and there is
no `unregisterTool()`. The previous three-package split (pi-model-tools for
tool-wrapping + pi-deepseek-tools + pi-glm for hooks) duplicated substantial
code across packages. Merging into one extension eliminates the duplication and
the "load three packages" ceremony while keeping every behavior.

## Model family detection

Provider-agnostic. Captures `sessionModel` at `session_start` for proxy-fallback
compatibility (e.g. opencode-go → 9router → GLM), so detection works against the
*requested* model even when a proxy rewrites `ctx.model` to the served one.

```typescript
detectFamily({ id: "glm-5.2", provider: "zai" })            // → "glm"
detectFamily({ id: "deepseek-v4-flash", provider: "ocg" })   // → "deepseek-v4"
detectFamily({ id: "claude-opus-4.8" })                      // → null
```

DeepSeek V4 matches any id containing `deepseek` and the word `v4`. GLM matches
any id containing `glm`. Non-matching models get repair + leak-clean only when
a family is detected; everything degrades gracefully to a no-op otherwise.

## Features

### Shared (all detected families)

| Feature | What it does |
|---------|-------------|
| **Tool argument repair** | Fixes invalid JSON, trailing commas, unquoted keys, JSON-string→object, top-level string→object (GLM-4.7 bug), **truncated-JSON auto-close** (DeepSeek mid-generation truncation — unterminated strings and unclosed brackets are closed), optional-null deletion, markdown autolinks in path fields |
| **Prompt cache stats** | Tracks per-turn `usage.cacheRead`/`cacheWrite`/`input` and reports the session cache hit rate in `/model-tools-status` (Pi core already computes these; this surfaces them) |
| **Leaked-content cleaning** | Strips leaked thinking headers and `` `tool_name(args)` `` prose from assistant messages (always on for detected families) |
| **Reasoning strip** | Removes accumulated `reasoning_content` from prior turns to prevent provider 400s on long sessions (opt-in) |
| **Dangerous command guard** | Blocks forced recursive delete of absolute paths (`rm -rf /`) and destructive `dd` writes |
| **Read-on-guessed-path blocking** | Blocks `read` on a non-existent code-file path, suggests `find` first |
| **Prompt-aware first-tool hints** | Forces the correct first tool: `bash`-first for RUN/BUILD/EXECUTE tasks, `bash` git-clone-first for analyze-a-repo-URL tasks, and `find`-first for bare-filename reads. Targeted (only fires on matching intent) and applied to all detected families. Injected into the current user message, not the system prompt, to keep the prefix-cache head byte-stable for both DeepSeek (exact-prefix cache) and GLM (Z.ai automatic content-similarity cache) (measured on DeepSeek: 99% hit retained vs 16% when hints lived in the system prompt). |
| **Error categorization** | Classifies tool errors and injects recovery hints on the next turn. Also detects provider 400s caused by accumulated `reasoning_content` (long-session reasoning-accumulation) and injects an actionable hint — `PI_MODEL_TOOLS_STRIP_REASONING=1` — so the rare trigger is self-documenting. |
| **Edit mismatch repair** | Strips `read`-tool truncation notices (`[Showing lines … Use offset=N to continue.]`, etc.) that models copy into `edit` oldText — the documented root cause of "Could not find the exact text" failures. On a match failure, retries once with whitespace-tolerant matching (copying the file's real indentation); on unresolvable matches, enriches the error with the nearest numbered region. Always on. |
| **`apply_patch` tool** | A Codex-style V4D diff/patch tool: emit only `@@` context + `-`/`+` change lines instead of large verbatim oldText blocks. Robust for multi-line/multi-file edits across all models. DeepSeek/GLM get steering to prefer it for non-trivial edits. |

### Prompt caching

Both supported families use **automatic prefix caching** — no explicit
`cache_control` field is sent (Zhipu actively rejects it with a 400, and Pi
core's zai compat leaves it off). The cache is keyed on the byte-stable
**system prompt + conversation history**:

- **DeepSeek V4** — exact prefix cache.
- **GLM** (GLM-4.5–5.3) — Z.ai automatic content-similarity cache
  ([docs](https://docs.z.ai/guides/capabilities/cache)); reported via
  `usage.prompt_tokens_details.cached_tokens`, which Pi core maps to
  `usage.cacheRead`.

The extension keeps that prefix byte-identical across turns so the cache stays
warm for both families:

- **Reasoning strip** (on by default) — replaces accumulated `reasoning_content`
  with `""` on prior assistant turns, removing non-deterministic bytes that grow
  the prefix differently each turn (the biggest single cache-stability factor;
  GLM's docs note history length affects the hit rate).
- **Dynamic guidance → user-message tail** — first-tool hints, error notes, and
  periodic reinforcement are appended to the *current* user message (the request
  tail), never the system prompt (the cache head).
- **Leaked-content cleaning** (always on) — strips `Reasoning:` headers and
  `` `tool_name(args)` `` prose, keeping formatting stable (GLM's docs note
  formatting differences affect the hit rate).

`/model-tools-status` reports the session hit rate
(`input`/`cached`/`written` tokens + `hitTurns`/`missTurns`) for whichever
family is active.

### DeepSeek V4 only (verbose steering the Flash model needs)

| Feature | What it does |
|---------|-------------|
| **Selection guidance** | Injects a first-tool quick-map (intent → tool) via `before_agent_start` to raise first-tool accuracy. Static per session (depends only on the active-tool set), so it stays in the system prompt without hurting the cache. |
| **ds-anchor (v4-pro)** | **Minimal-mode two-phase bootstrap.** Request #1 of a `deepseek-v4-pro` session replaces the system prompt with the byte-identical DSH Minimal persona (`You are a helpful software engineer assistant.`) and exposes only `bash`+`str_replace_editor` (the real Minimal pair); after the first durable assistant message the session promotes to the full prompt + catalog + all guidance. See [DeepSeek v4 Pro minimal-mode anchor](#deepseek-v4-pro-minimal-mode-anchor). |
| **Semantic-miss steering** | Blocks bash/grep for code symbols → suggests the right Serena tool instead |
| **Strict Serena mode** | Optionally hard-blocks simple `bash` substitutes (`ls`, `grep`, `cat`, `find`, `head`, `tail`) for dedicated tools |
| **Super Power Mode** | Prepends an unrestricted capability prompt each DeepSeek session (see below) |

## Installation

```bash
pi install npm:@bacnh85/pi-model-tools
```

## `apply_patch` — diff-based editing

`apply_patch` is a Codex-style V4D patch tool. Instead of reproducing a large
verbatim `oldText` block (where weaker models drift on indentation/quotes),
you emit only the changed lines plus a little surrounding context:

```
*** Begin Patch
*** Update File: src/foo.ts
@@ export function foo() {
-  return 1;
+  return 2;
*** End Patch
```

Rules:
- `*** Add File: <path>` — one `+` line per content line (creates the file).
- `*** Delete File: <path>` — no payload lines.
- `*** Update File: <path>` — hunks; also `*** Update File: <old> → <new>` to rename.
- Each Update hunk starts with a `@@ <unchanged context line>` anchor, then
  `-` removed lines and `+` added lines. Leading-space context lines (` `) are
  also accepted.
- Context+removed must match **uniquely** in the file (diverges from Codex's
  first-match for safety, matching `edit`'s philosophy). Add more context lines
  if a match is ambiguous.
- If the `@@` anchor text repeats as the immediately-following context or
  removed line (common when models treat `@@` as a diff-style locator header),
  the duplicate is auto-collapsed — only one occurrence is matched.
- Matching is progressive-fuzzy (exact → strip-trailing-ws → strip-both-ws →
  Unicode-normalize), so minor whitespace/Unicode differences still apply.

DeepSeek and GLM are steered to prefer `apply_patch` for multi-line/multi-hunk
edits; Claude/OpenAI keep using `edit` (they're already reliable with it).

## Commands

| Command | Description |
|---------|-------------|
| `/model-tools-status` | Shows detected family, repair counts, error history, prompt-cache stats (input/cached/written tokens + hit rate), and DeepSeek Super Power Mode + turn count |

## Configuration

All toggles live under the `PI_MODEL_TOOLS_*` namespace.

### Shared

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_MODEL_TOOLS_REPAIR_ENABLED` | 1 | Tool argument repair (`0`/`off`/`false` to disable) |
| `PI_MODEL_TOOLS_STRIP_REASONING` | 0 | Strip accumulated reasoning from prior turns |
| `PI_MODEL_TOOLS_REASONING_MAX_CHARS` | unlimited | Truncate long reasoning fields to N characters |
| `PI_MODEL_TOOLS_BLOCK_DANGEROUS_COMMANDS` | 1 | Safety guard (on by default) |
| `PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS` | 0 | Auto-block tool-selection misses after N reminders |
| `PI_MODEL_TOOLS_MAX_ERROR_HISTORY` | 100 | Maximum tracked tool errors |
| `PI_MODEL_TOOLS_DEBUG` | 0 | stderr diagnostic logging |
| `PI_MODEL_TOOLS_LOG_FORMAT` | plain | `json` for structured log lines |

### DeepSeek V4 only

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_MODEL_TOOLS_SELECTION_GUIDANCE` | on | `0`/`off`/`false` to disable the compact first-tool routing table (DeepSeek V4 only) |
| `PI_MODEL_TOOLS_STRICT_SERENA` | off | `1`/`on`/`true` to hard-block simple bash substitutes |
| `PI_MODEL_TOOLS_SUPERPOWER_MODE` | off | `1`/`on`/`true` to enable Super Power Mode (off by default — the global AGENTS.md already enforces the same behavior, and the persona prompt adds permanent prefix-cache cost) |
| `PI_MODEL_TOOLS_DS_ANCHOR` | on | `0`/`off`/`false` to disable the DeepSeek v4 Pro minimal-mode two-phase bootstrap |
| `PI_MODEL_TOOLS_DS_ANCHOR_WE_NEED` | off | `1`/`on`/`true` to prepend the "We need…" thinking directive to the bootstrap prompt (A/B knob) |
| `PI_MODEL_TOOLS_CUSTOM_SUPERPOWER_PROMPT` | unset | Custom Super Power prompt (overrides the built-in one) |

> **Note:** The former `PI_DEEPSEEK_TOOLS_THINKING_BUDGET` toggle has been
> removed. It was dead code (never wired into any hook). Pi 0.80.6+ manages
> thinking natively via `thinkingLevelMap` (DeepSeek V4 supports `off`/`high`/`max`),
> selected through Shift+Tab, `/settings`, or `--thinking`.

## Super Power Mode

Enabled by default for DeepSeek V4 sessions. It prepends an unrestricted
capability prompt at the top of the system prompt (before the selection
guidance and the base prompt), removes content filters, and engages maximum
reasoning effort. A light reinforcement is appended every 10 turns.

```bash
# Enable (off by default)
export PI_MODEL_TOOLS_SUPERPOWER_MODE=1

# Use a custom prompt instead of the built-in one
export PI_MODEL_TOOLS_CUSTOM_SUPERPOWER_PROMPT="You are an elite coder. No limits."
```

`/model-tools-status` reports whether Super Power Mode is on, whether a custom
prompt is in use, and the current turn count.

## DeepSeek v4 Pro minimal-mode anchor

Community finding (r/DeepSeek 1vovxxc, confirmed by DeepSeek staff): DeepSeek
v4 Pro GA is overfitted to DeepSeek Harness (DSH) *minimal mode* — a one-line
system prompt with only `bash` + an editor tool exposed. Sessions that start
in that exact distribution consistently reach the model's benchmark-level
performance; sessions that start with a large harness prompt can degrade into
loops.

**How it works** (default on for model ids containing `deepseek-v4-pro`):

1. **Bootstrap (request #1)** — the system prompt is replaced byte-identically
   with `You are a helpful software engineer assistant.` and the provider
   payload's tools are narrowed to the **real DSH Minimal pair**: `bash` +
   `str_replace_editor` (a faithful port of DSH's view/create/str_replace/
   insert editor, byte-identical name/schema/description). All other guidance
   (Super Power, selection guidance, first-tool hints, steering) is suppressed
   for this request. The dangerous-command guard stays active.
2. **Promotion** — after the first durable assistant message (tool call or
text), the session promotes: full Pi system prompt, full tool catalog, and all
existing pi-model-tools guidance apply unchanged from request #2 on.

The tool pair is NOT arbitrary — it is the measured anchor lever
(dsh-anchored-standard issue #11): the real Minimal schema
(`bash`+`str_replace_editor`) produced `We need…` first lines **5/5**, while
`pwsh`/`read` and `bash`/`read` substitutions produced standard-like `The
user…` first lines **11/11**. Earlier community ports used `bash`+`read`;
those do not anchor — a session whose first thinking starts with "The user
says…" instead of "we need…" is running a non-anchoring schema.

**Semantics:**

- Promotion is derived from durable session entries — resuming an
  already-replied session is instantly promoted; forks re-derive from their own
  entries (append-only).
- `/model` switches to/from a pro model re-init correctly (a session switched
  into pro after replies exist starts promoted — exact bootstrap experiments
  need a fresh session).
- Tools hallucinated during bootstrap (anything outside `bash`/`str_replace_editor`)
  are blocked with a clear reason.
- `str_replace_editor` is registered whenever the anchor is enabled (default)
  and also stays in the promoted catalog — it is a generally useful
  view/create/replace/insert editor. Disable the anchor to remove it.
- Everything fail-opens to the full catalog on surprise (no session access,
  malformed payload, missing `bash`/`str_replace_editor`) with a one-time warning.
- Recommend `/thinking max` — the community recipe pairs minimal mode with max
  thinking for full effect.

**Caveats:** other extensions that rewrite the system prompt or tool list after
this one break byte-identity of request #1 — load pi-model-tools **last** for
exact anchoring (check `/model-tools-status` → `ds-anchor: bootstrapping` to
confirm it took). Proxy-rewritten sessions (requested as another model, served
as `deepseek-v4-pro`) are handled: the target check runs per hook, so the
bootstrap engages on the served model even when `model_select` never fires.

**Verifying the bootstrap actually happened:** run `/model-tools-status` after
the first turn — the `ds-anchor trace` section shows the session's anchor
activity:

```
ds-anchor (v4-pro): promoted

ds-anchor trace:
  12:00:01 session_start: requested=deepseek-v4-pro → target
  12:00:02 bootstrap: minimal prompt engaged (model=deepseek-v4-pro)
  12:00:03 payload: tools=[bash,str_replace_editor] sent to deepseek-v4-pro
  12:00:12 promoted: first durable assistant reply received
```

If the trace shows `bootstrap: minimal prompt engaged` + `payload:
tools=[bash,str_replace_editor]` on turn 1, the anchor reached the model. If
the thinking still doesn't start "We need…" with that confirmed, the served
model route itself is the variable (different checkpoint/quantization than the
community benchmarked), not the anchor. With `PI_MODEL_TOOLS_DEBUG=1` the same
decisions also print to stderr with the exact system prompt + tool schemas.

**A/B knob — the portable "we need…" directive:** the community's portable
variant adds an explicit thinking directive on top of the minimal prompt. It is
NOT part of the byte-identical DSH recipe (which the 98/99 runs used without
it), but on routes where the pure prompt doesn't reproduce the trajectory,
`PI_MODEL_TOOLS_DS_ANCHOR_WE_NEED=1` prepends
`When you think, start each thinking paragraph with "We need…".` to the
bootstrap prompt. The trace shows `+we-need directive` when active.

**Thinking level:** the recipe requires **max** thinking
(`/thinking max`). `/model-tools-status` now shows the current level and flags
`(recipe wants max)` when an anchored session is below max.

**Output budget:** the bootstrap request pins `max_tokens: 256000` — the exact
budget in DSH's captured minimal-mode payload (issue #11 isolated the output
budget as a trajectory lever). The pin applies to request #1 only; promoted
requests revert to the model's configured budget. If the first thinking still
reads standard-like with the pin in place, the served model route (checkpoint
or quantization) is the remaining variable.

Design ported from [hank9999/pi-ds-anchored](https://github.com/hank9999/pi-ds-anchored)
(MIT), from [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
(Project2 benchmark: 98/99).

```bash
# Disable (default on)
export PI_MODEL_TOOLS_DS_ANCHOR=0
```

## Development & Testing

```bash
npm test        # unit tests
npm run typecheck
npm pack --dry-run
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Guidance not injected | `PI_MODEL_TOOLS_SELECTION_GUIDANCE=0`, or model is not DeepSeek V4 | Verify model id contains `deepseek` and `v4` |
| Reasoning 400 errors | Provider rejects accumulated reasoning fields | `PI_MODEL_TOOLS_STRIP_REASONING=1` |
| Reasoning 400 only on long responses | Provider content-length limit | `PI_MODEL_TOOLS_REASONING_MAX_CHARS=4096` |
| Excessive reminder messages | Model consistently mis-selects tools | `PI_MODEL_TOOLS_STRICT_SERENA=1` |
| `/model-tools-status` not found | Extension not loaded | Check settings and run `/reload` |
| Super Power prompt not injecting | `PI_MODEL_TOOLS_SUPERPOWER_MODE` not `1`/`on`/`true`, or model is not DeepSeek V4 | Set `=1` and verify the model id contains `deepseek` and `v4` |
| Custom Super Power prompt not loading | `PI_MODEL_TOOLS_CUSTOM_SUPERPOWER_PROMPT` unset | Set the env var to your prompt text |
| Old config ignored | Still using `PI_DEEPSEEK_TOOLS_*` / `PI_GLM_*` names | Rename to `PI_MODEL_TOOLS_*` (see tables above) |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Related

- [pi-serena](https://github.com/bacnh85/pi-extensions/tree/main/pi-serena) — Serena semantic code tools (used by DeepSeek steering)
