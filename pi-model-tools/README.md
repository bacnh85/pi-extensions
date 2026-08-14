# @bacnh85/pi-model-tools

**Unified model-family support for Pi** — tool interception, argument repair,
reasoning management, defensive leak-cleaning, DeepSeek V4 selection guidance,
and Super Power Mode, all in one extension. Currently supports **DeepSeek V4**
and **GLM** (GLM-4.5 through GLM-5.2) from any provider.

This is the **single source of tool handling** for these families. It does NOT
re-register the built-in tools (read, write, edit, grep, find, ls, bash) —
`pi.registerTool` resolves name collisions by last-wins, so re-registering
would silently clobber other extensions that own those tools. Instead it
intercepts through the SDK's `tool_call`/`tool_result` hooks (in-place
`event.input` mutation), which compose with whichever extension registered the
tool, and routes behavior by detected model family.

> **Merged package (v0.2.0).** This package now absorbs the former
> `pi-deepseek-tools` and `pi-glm` extensions. Those packages are deprecated;
> their last published versions remain on npm but receive no further updates.
> All configuration is unified under the `PI_MODEL_TOOLS_*` namespace (the old
> `PI_DEEPSEEK_TOOLS_*` / `PI_GLM_*` names are no longer read).

## Why one package

Pi's `ExtensionAPI` cannot conditionally register tools — `registerTool()`
runs at load time, name collisions resolve by last-wins (no conflict error), and
there is no `unregisterTool()`. Re-registering the built-in tools from an
extension therefore silently clobbers any other extension that also owns them.
Intercepting via the `tool_call`/`tool_result` hooks (documented: "mutate
`event.input` in place to patch tool arguments before execution") achieves the
same behavior without touching the registry, and is load-order independent.
The previous three-package split (pi-model-tools for tool-wrapping +
pi-deepseek-tools + pi-glm for hooks) duplicated substantial code across
packages. Merging into one extension eliminates the duplication and the "load
three packages" ceremony while keeping every behavior.

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
| **Edit mismatch repair** | Strips `read`-tool truncation notices (`[Showing lines … Use offset=N to continue.]`, etc.) that models copy into `edit` oldText — the documented root cause of "Could not find the exact text" failures. Before the edit executes, oldText is pre-flighted against a whitespace-tolerant match and rewritten to the file's real indentation when the match is unique; unresolvable mismatches get their error enriched with the nearest numbered region. Always on. |
| **`apply_patch` tool** | A Codex-style V4D diff/patch tool: emit only `@@` context + `-`/`+` change lines instead of large verbatim oldText blocks. Robust for multi-line/multi-file edits across all models. DeepSeek/GLM get steering to prefer it for non-trivial edits. Writes directly to the host filesystem, so it is hard-blocked at runtime in sandboxed sessions; registration can be skipped entirely via `PI_MODEL_TOOLS_APPLY_PATCH=0`. |

### Prompt caching

Both supported families use **automatic prefix caching** — no explicit
`cache_control` field is sent (Zhipu actively rejects it with a 400, and Pi
core's zai compat leaves it off). The cache is keyed on the byte-stable
**system prompt + conversation history**:

- **DeepSeek V4** — exact prefix cache.
- **GLM** (GLM-4.5–5.2) — Z.ai automatic content-similarity cache
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
| **Semantic-miss steering** | Blocks bash/grep for code symbols → suggests the right Serena tool instead |
| **Strict Serena mode** | Optionally hard-blocks simple `bash` substitutes (`ls`, `grep`, `cat`, `find`, `head`, `tail`) for dedicated tools |
| **Super Power Mode** | Prepends an unrestricted capability prompt each DeepSeek session (see below) |

## Sandbox compatibility

`pi-model-tools` interoperates with sandboxing extensions — such as
**pi-tg-gondolin** (a VM sandbox that re-registers the built-in tools inside a
virtual machine) — by intercepting via
the `tool_call` hook instead of re-registering anything. The host resolves a
tool name registered by multiple extensions by **first-registration-per-name**,
so both extensions coexist regardless of load order.

A session is treated as **sandboxed** when either:

- `PI_TOOLS_ARE_SANDBOXED` is set to `1`/`true`/`yes`/`on` — the shared
  convention flag. A sandboxing extension sets it in its module top-level (all
  extension modules load before `session_start`, so it is visible to every
  extension regardless of load order); launchers can also set it. Set it to
  `0`/`false`/`no`/`off` to override auto-detection.
- otherwise, auto-detected: any of the host file tools (`read`/`write`/`edit`/`bash`)
  is owned by an extension rather than the host (its `sourceInfo` is not
  `builtin`).

When sandboxed:

- **`apply_patch` is hard-blocked at runtime** only when the *live* `apply_patch`
  is ours — the raw `node:fs` version that would bypass the sandbox VM. If the
  sandbox owns `apply_patch` (VM-routed), it is allowed and still suggested.
  The block fires in the `tool_call` hook before any owner executes it, so it is
  load-order independent. Set `PI_MODEL_TOOLS_APPLY_PATCH=0` to skip registration
  entirely.
- **Edit repair composes with the VM-wrapped edit.** Pre-flight rewriting and
  `tool_result` error enrichment run in the hooks, so they work whether the
  host's or the sandbox's `edit` executes.
- **Permission denials read correctly.** Sandboxed paths denied to the agent
  surface as `ENOENT`; error hints steer to `request_access` when that tool is
  present, otherwise to generic access-granting recovery, instead of the usual
  "find first".
- **`apply_patch` steering is suppressed** when ours is blocked, so the model
  isn't nudged into a call that would be rejected.

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
edits; Claude/OpenAI keep using `edit` (they're already reliable with it). In
sandboxed sessions the hint is suppressed while our raw-fs `apply_patch` is
blocked (see [Sandbox compatibility](#sandbox-compatibility)).

## Commands

| Command | Description |
|---------|-------------|
| `/model-tools-status` | Shows detected family, sandbox state (`yes (declared)` / `yes (auto-detected)` / `no`), repair counts, error history, prompt-cache stats (input/cached/written tokens + hit rate), and DeepSeek Super Power Mode + turn count |

## Configuration

All toggles live under the `PI_MODEL_TOOLS_*` namespace, with one exception:
`PI_TOOLS_ARE_SANDBOXED` is the cross-extension sandbox convention (see
[Sandbox compatibility](#sandbox-compatibility)).

### Shared

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_TOOLS_ARE_SANDBOXED` | unset | Declare the session sandboxed (`1`/`true`/`yes`/`on`) or override auto-detection (`0`/`false`/`no`/`off`). Shared with sandboxing extensions. |
| `PI_MODEL_TOOLS_REPAIR_ENABLED` | 1 | Tool argument repair (`0`/`off`/`false` to disable) |
| `PI_MODEL_TOOLS_STRIP_REASONING` | 0 | Strip accumulated reasoning from prior turns |
| `PI_MODEL_TOOLS_REASONING_MAX_CHARS` | unlimited | Truncate long reasoning fields to N characters |
| `PI_MODEL_TOOLS_BLOCK_DANGEROUS_COMMANDS` | 1 | Safety guard (on by default) |
| `PI_MODEL_TOOLS_APPLY_PATCH` | 1 | Register the `apply_patch` tool (`0`/`off`/`false` to skip registration) |
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
| `PI_MODEL_TOOLS_CUSTOM_SUPERPOWER_PROMPT` | unset | Custom Super Power prompt (overrides the built-in one) |

> **Note:** The former `PI_DEEPSEEK_TOOLS_THINKING_BUDGET` toggle has been
> removed. It was dead code (never wired into any hook). Pi 0.80.6+ manages
> thinking natively via `thinkingLevelMap` (DeepSeek V4 supports `off`/`high`/`max`),
> selected through Shift+Tab, `/settings`, or `--thinking`.

## Super Power Mode

Off by default for DeepSeek V4 sessions (the global AGENTS.md already enforces
the same behavior, and the persona prompt adds permanent prefix-cache cost).
When enabled, it prepends an unrestricted capability prompt at the top of the
system prompt (before the selection guidance and the base prompt), removes
content filters, and engages maximum reasoning effort. A light reinforcement
is appended every 10 turns.
```bash
# Enable (off by default)
export PI_MODEL_TOOLS_SUPERPOWER_MODE=1

# Use a custom prompt instead of the built-in one
export PI_MODEL_TOOLS_CUSTOM_SUPERPOWER_PROMPT="You are an elite coder. No limits."
```

`/model-tools-status` reports whether Super Power Mode is on, whether a custom
prompt is in use, and the current turn count.

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
| `apply_patch` blocked in sandboxed sessions | A sandboxing extension is active (auto-detected or `PI_TOOLS_ARE_SANDBOXED=1`) | Intentional: our `apply_patch` writes raw `node:fs` and would bypass the sandbox. Use `edit`; set `PI_MODEL_TOOLS_APPLY_PATCH=0` to skip registration, or `PI_TOOLS_ARE_SANDBOXED=0` to override detection |
| `apply_patch` missing from the tool list | `PI_MODEL_TOOLS_APPLY_PATCH=0` | Unset the env var to register it |
| Old config ignored | Still using `PI_DEEPSEEK_TOOLS_*` / `PI_GLM_*` names | Rename to `PI_MODEL_TOOLS_*` (see tables above) |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Related

- [pi-serena](https://github.com/bacnh85/pi-extensions/tree/main/pi-serena) — Serena semantic code tools (used by DeepSeek steering)
