# pi-model-tools

**Unified model-family support for Pi** — tool-wrapping, argument repair,
reasoning management, defensive leak-cleaning, DeepSeek V4 selection guidance,
and Super Power Mode, all in one extension. Currently supports **DeepSeek V4**
and **GLM** (GLM-4.5 through GLM-5.2) from any provider.

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
| **Tool argument repair** | Fixes invalid JSON, trailing commas, unquoted keys, JSON-string→object, top-level string→object (GLM-4.7 bug), optional-null deletion, markdown autolinks in path fields |
| **Leaked-content cleaning** | Strips leaked thinking headers and `` `tool_name(args)` `` prose from assistant messages (always on for detected families) |
| **Reasoning strip** | Removes accumulated `reasoning_content` from prior turns to prevent provider 400s on long sessions (opt-in) |
| **Dangerous command guard** | Blocks forced recursive delete of absolute paths (`rm -rf /`) and destructive `dd` writes |
| **Read-on-guessed-path blocking** | Blocks `read` on a non-existent code-file path, suggests `find` first |
| **Prompt-aware first-tool hints** | Forces the correct first tool: `bash`-first for RUN/BUILD/EXECUTE tasks, `bash` git-clone-first for analyze-a-repo-URL tasks, and `find`-first for bare-filename reads. Targeted (only fires on matching intent) and applied to all detected families. |
| **Error categorization** | Classifies tool errors and injects recovery hints on the next turn |
| **Edit mismatch repair** | Strips `read`-tool truncation notices (`[Showing lines … Use offset=N to continue.]`, etc.) that models copy into `edit` oldText — the documented root cause of "Could not find the exact text" failures. On a match failure, retries once with whitespace-tolerant matching (copying the file's real indentation); on unresolvable matches, enriches the error with the nearest numbered region. Always on. |
| **`apply_patch` tool** | A Codex-style V4D diff/patch tool: emit only `@@` context + `-`/`+` change lines instead of large verbatim oldText blocks. Robust for multi-line/multi-file edits across all models. DeepSeek/GLM get steering to prefer it for non-trivial edits. |

### DeepSeek V4 only (verbose steering the Flash model needs)

| Feature | What it does |
|---------|-------------|
| **Selection guidance** | Injects a first-tool quick-map (intent → tool) via `before_agent_start` to raise first-tool accuracy |
| **Semantic-miss steering** | Blocks bash/grep for code symbols → suggests the right Serena tool instead |
| **Strict Serena mode** | Optionally hard-blocks simple `bash` substitutes (`ls`, `grep`, `cat`, `find`, `head`, `tail`) for dedicated tools |
| **Super Power Mode** | Prepends an unrestricted capability prompt each DeepSeek session (see below) |

## Installation

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
- Matching is progressive-fuzzy (exact → strip-trailing-ws → strip-both-ws →
  Unicode-normalize), so minor whitespace/Unicode differences still apply.

DeepSeek and GLM are steered to prefer `apply_patch` for multi-line/multi-hunk
edits; Claude/OpenAI keep using `edit` (they're already reliable with it).

## Installation

```bash
pi install npm:@bacnh85/pi-model-tools
```

Or load from source for development:

```bash
pi -e ./pi-model-tools/extensions/index.ts
```

Load it alongside `pi-serena` when you want the semantic-miss steering and
serena-first suggestions to take effect.

## Commands

| Command | Description |
|---------|-------------|
| `/model-tools-status` | Shows detected family, repair counts, error history, and DeepSeek Super Power Mode + turn count |

## Configuration

All toggles live under the `PI_MODEL_TOOLS_*` namespace.

### Shared

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_MODEL_TOOLS_REPAIR_ENABLED` | 1 | Tool argument repair (`0`/`off`/`false` to disable) |
| `PI_MODEL_TOOLS_STRIP_REASONING` | 0 | Strip accumulated reasoning from prior turns |
| `PI_MODEL_TOOLS_REASONING_MAX_TOKENS` | unlimited | Truncate long reasoning fields to N characters |
| `PI_MODEL_TOOLS_BLOCK_DANGEROUS_COMMANDS` | 1 | Safety guard (on by default) |
| `PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS` | 0 | Auto-block tool-selection misses after N reminders |
| `PI_MODEL_TOOLS_MAX_ERROR_HISTORY` | 100 | Maximum tracked tool errors |
| `PI_MODEL_TOOLS_DEBUG` | 0 | stderr diagnostic logging |
| `PI_MODEL_TOOLS_LOG_FORMAT` | plain | `json` for structured log lines |

### DeepSeek V4 only

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_MODEL_TOOLS_SELECTION_GUIDANCE` | on | `0`/`off`/`false` to disable guidance injection |
| `PI_MODEL_TOOLS_STRICT_SERENA` | off | `1`/`on`/`true` to hard-block simple bash substitutes |
| `PI_MODEL_TOOLS_SUPERPOWER_MODE` | on | `0`/`off`/`false` to disable Super Power Mode |
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
# Disable
export PI_MODEL_TOOLS_SUPERPOWER_MODE=0

# Use a custom prompt instead of the built-in one
export PI_MODEL_TOOLS_CUSTOM_SUPERPOWER_PROMPT="You are an elite coder. No limits."
```

`/model-tools-status` reports whether Super Power Mode is on, whether a custom
prompt is in use, and the current turn count.

## Usage

```bash
cd pi-model-tools && npm install
npm test        # unit tests
npm run typecheck
npm pack --dry-run
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Guidance not injected | `PI_MODEL_TOOLS_SELECTION_GUIDANCE=0`, or model is not DeepSeek V4 | Verify model id contains `deepseek` and `v4` |
| Reasoning 400 errors | Provider rejects accumulated reasoning fields | `PI_MODEL_TOOLS_STRIP_REASONING=1` |
| Reasoning 400 only on long responses | Provider content-length limit | `PI_MODEL_TOOLS_REASONING_MAX_TOKENS=1024` |
| Excessive reminder messages | Model consistently mis-selects tools | `PI_MODEL_TOOLS_STRICT_SERENA=1` |
| `/model-tools-status` not found | Extension not loaded | Check settings and run `/reload` |
| Super Power prompt not injecting | Model is not DeepSeek V4, or `PI_MODEL_TOOLS_SUPERPOWER_MODE=0` | Set `=1` (or remove the `=0`) and verify the model id |
| Custom Super Power prompt not loading | `PI_MODEL_TOOLS_CUSTOM_SUPERPOWER_PROMPT` unset | Set the env var to your prompt text |
| Old config ignored | Still using `PI_DEEPSEEK_TOOLS_*` / `PI_GLM_*` names | Rename to `PI_MODEL_TOOLS_*` (see tables above) |

## Related

- [pi-serena](https://github.com/bacnh85/pi-extensions/tree/main/pi-serena) — Serena semantic code tools (used by DeepSeek steering)
