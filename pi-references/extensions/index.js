/**
 * pi-references — external context roots for Pi.
 *
 * Alias sibling directories or git repositories as `@docs`, `@sdk`, etc., and
 * reference them by name in chat. Local refs resolve at startup; git refs clone
 * lazily into a cache dir on first use. References with a `description` are
 * injected into the agent's system prompt so the model knows they exist.
 *
 * Config (.pi/settings.json or ~/.pi/agent/settings.json):
 *   "references": {
 *     "docs": { "path": "../product-docs", "description": "Product behavior & conventions" },
 *     "sdk":  { "repository": "owner/repo", "branch": "main", "description": "JS SDK impl" }
 *   }
 *
 * The model can then read files under the resolved root (which is also added to
 * the permission allowlist for path tools). `@alias` autocomplete is a future
 * TUI enhancement; today references are surfaced via system-prompt injection +
 * the /refs command.
 *
 * Zero deps, plain JS (pi-budget pattern).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";

const CACHE_DIR_SUFFIX = "refs";

/**
 * Normalize a single reference definition. Returns null if invalid.
 * Exported for unit testing.
 *
 * @param {string} alias
 * @param {object|string} def  - {path} | {repository, branch?} | "../dir" | "owner/repo"
 * @param {string} cwd        - project root, for resolving relative paths
 * @param {string} cacheRoot  - base dir for git-clone cache
 */
export function normalizeReference(alias, def, cwd, cacheRoot) {
  if (!alias || typeof alias !== "string") return null;
  // alias must not contain slash/whitespace/backtick/comma (OpenCode rule)
  if (/[/\s,`]/.test(alias)) return null;

  const obj = typeof def === "string" ? parseShorthand(def) : { ...def };
  if (!obj || typeof obj !== "object") return null;

  const out = {
    alias,
    description: obj.description || null,
    hidden: !!obj.hidden,
    path: null,
    repository: null,
    branch: null,
  };

  if (obj.path) {
    const resolved = isAbsolute(obj.path) || obj.path.startsWith("~")
      ? obj.path
      : resolve(cwd || ".", obj.path);
    out.path = resolved;
    return out;
  }

  if (obj.repository) {
    out.repository = obj.repository;
    out.branch = obj.branch || null;
    // Cache path: <cacheRoot>/<alias>
    out.path = join(cacheRoot || ".", alias);
    return out;
  }

  return null;
}

/**
 * Parse string shorthand: "../dir" → {path}; "owner/repo" → {repository}.
 */
function parseShorthand(s) {
  const str = String(s).trim();
  if (!str) return null;
  // Looks like a path (starts with ./, ../, /, ~)
  if (/^(\.\.?\/|\/|~)/.test(str)) return { path: str };
  // Looks like owner/repo or a git URL
  if (/^([\w.-]+\/[\w.-]+)$/.test(str) || /^https?:\/\//.test(str) || /^git@/.test(str)) {
    return { repository: str };
  }
  // Fallback: treat as a relative path
  return { path: str };
}

/**
 * Ensure a git reference is cloned into its cache path. Returns true on success
 * (or already present), false on failure. Best-effort: never throws.
 * Exported for testing with a fake exec.
 */
export async function ensureCloned(ref, execFn) {
  if (!ref?.repository || !ref?.path) return true; // local ref, nothing to clone
  if (existsSync(join(ref.path, ".git"))) return true; // already cloned
  try {
    mkdirSync(ref.path, { recursive: true });
  } catch { /* best-effort */ }
  const url = ref.repository.includes("://") || ref.repository.startsWith("git@")
    ? ref.repository
    : `https://github.com/${ref.repository}.git`;
  const args = ["clone", url, ref.path];
  // Guard against branch/ref values starting with `-` (argument injection from
  // trusted config). Pass `--` before user-supplied values is awkward with git
  // clone's option ordering, so we just reject dashed branches defensively.
  if (ref.branch && !String(ref.branch).startsWith("-")) {
    args.splice(1, 0, "--branch", ref.branch);
  }
  try {
    const res = await execFn("git", args);
    return !res?.failed;
  } catch {
    return false;
  }
}

/**
 * Build the system-prompt snippet advertising non-hidden references with
 * descriptions. Exported for testing.
 */
export function buildContextSnippet(refs) {
  const advertised = refs.filter((r) => r.description && !r.hidden);
  if (advertised.length === 0) return "";
  const lines = [
    "## Project references",
    "The following external directories are available. Read files under these roots when relevant:",
  ];
  for (const r of advertised) {
    lines.push(`- \`@${r.alias}\` → ${r.path}: ${r.description}`);
  }
  return lines.join("\n");
}

export default function referencesExtension(pi) {
  let refs = [];
  let snippet = "";

  function loadConfig(ctx) {
    const cfg = pi.getSetting?.("references") || pi.config?.references || {};
    const cwd = ctx?.cwd || process.cwd();
    const cacheRoot = join(
      process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "", ".pi", "agent"),
      CACHE_DIR_SUFFIX,
    );
    refs = Object.entries(cfg)
      .map(([alias, def]) => normalizeReference(alias, def, cwd, cacheRoot))
      .filter(Boolean);
    snippet = buildContextSnippet(refs);
  }

  pi.on("session_start", (_event, ctx) => {
    loadConfig(ctx);
    if (refs.length === 0) return;

    // Ensure git refs are cloned (lazy, best-effort, non-blocking for local).
    Promise.all(
      refs.map((r) =>
        ensureCloned(r, (cmd, args) => pi.exec(cmd, args, { cwd: ctx?.cwd })).then((ok) => {
          if (!ok && ctx?.hasUI) {
            try {
              ctx.ui.notify(`Failed to clone reference @${r.alias}`, "warning");
            } catch { /* best-effort */ }
          }
        }),
      ),
    ).catch(() => { /* best-effort */ });
  });

  // Inject the reference list into the system prompt every turn.
  pi.on("before_agent_start", (event, _ctx) => {
    if (!snippet) return;
    try {
      const opts = event.systemPromptOptions;
      if (opts?.appendSystemPrompt) {
        opts.appendSystemPrompt = opts.appendSystemPrompt + "\n\n" + snippet;
      } else if (opts) {
        opts.appendSystemPrompt = snippet;
      }
    } catch { /* best-effort */ }
  });

  // /refs command: list configured references and their resolved paths.
  pi.registerCommand("refs", {
    description: "List configured project references (@alias → path)",
    handler: async (_args, ctx) => {
      if (refs.length === 0) {
        ctx.ui.notify("No references configured (set `references` in settings.json).", "info");
        return;
      }
      const lines = refs.map((r) => {
        const kind = r.repository ? "git" : "local";
        const desc = r.description ? ` — ${r.description}` : "";
        return `  @${r.alias} [${kind}] → ${r.path}${desc}`;
      });
      ctx.ui.notify(`References:\n${lines.join("\n")}`, "info");
    },
  });
}
