/**
 * pi-permission — granular permission system for Pi.
 *
 * Config-driven allow/ask/deny rules per tool, with wildcard pattern matching
 * and a doom-loop guard. An opt-in companion to Pi's container-first philosophy
 * ("No permission popups. Run in a container, or build your own") for users who
 * cannot always containerize.
 *
 * Config (in .pi/settings.json or ~/.pi/agent/settings.json), e.g. a bash
 * allowlist with a catch-all ask, an edit allowlist scoped under src, and a
 * read denylist for .env files. See README for the full JSON.
 *
 * Actions: "allow" (silent), "ask" (prompt via ctx.ui), "deny" (block).
 * Patterns: star (zero+ chars), question (exactly one char), else literal.
 * Last match wins.
 *
 * Flags:
 *   --yolo / --auto   auto-approve any "ask" (explicit deny still enforced)
 *
 * The doom-loop guard blocks the 3rd identical tool call in a row.
 *
 * Zero deps, plain JS (pi-budget pattern). Permission matching is the one
 * non-trivial piece — it has its own test suite.
 */

import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Convert an OpenCode-style wildcard pattern to a RegExp.
 * `*` → zero+ chars, `?` → exactly one char, everything else literal.
 * Patterns match against the WHOLE subject string (anchored).
 *
 * Exported for unit testing.
 */
export function wildcardToRegex(pattern) {
  // Escape regex specials, collapse runs of `*` (OpenCode: `*` matches zero or
  // more of ANY char including `/`, so `**` == `*`), convert `?` to any-one.
  let re = "";
  let prevStar = false;
  for (const ch of String(pattern)) {
    if (ch === "*") {
      if (prevStar) continue; // collapse **, ***, ... → single .*
      re += ".*";
      prevStar = true;
      continue;
    }
    prevStar = false;
    if (ch === "?") re += ".";
    else if ("\\^$.|+()[]{}:".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp("^" + re + "$");
}

/**
 * Resolve a single rule object { pattern: action } to an action for a subject.
 * Rules evaluated in insertion order, LAST matching rule wins (OpenCode semantics).
 * Returns "allow" | "ask" | "deny" | null (null = no rule matched).
 * If `home` is provided, `~` and `$HOME` are expanded in BOTH pattern and subject
 * so a pattern like `~/projects/**` matches an absolute path like `/home/u/...`.
 * Exported for unit testing.
 */
export function resolveRule(rules, subject, home) {
  if (!rules || typeof rules !== "object") return null;
  let action = null;
  const subj = home ? expandHome(subject, home) : subject;
  for (const [pattern, val] of Object.entries(rules)) {
    const pat = home ? expandHome(pattern, home) : pattern;
    if (wildcardToRegex(pat).test(subj)) action = val;
  }
  return action;
}

/**
 * Expand leading ~ or $HOME in a path pattern.
 */
function expandHome(pattern, home) {
  if (pattern === "~") return home;
  if (pattern.startsWith("~/")) return join(home, pattern.slice(2));
  if (pattern.startsWith("$HOME/")) return join(home, pattern.slice(6));
  return pattern;
}

// Avoid importing node:path just for join — keep zero-dep.
function join(base, rest) {
  return base.replace(/\/$/, "") + "/" + rest.replace(/^\//, "");
}

/**
 * Read a settings.json key directly from disk. The SDK's ExtensionAPI has NO
 * getSetting/config (only registerFlag/getFlag for CLI flags), so structured
 * config must be read from <cwd>/.pi/settings.json → ~/.pi/agent/settings.json,
 * first existing file wins (per-package settings readers — extract to a shared
 * helper when a fourth copy appears).
 */
export function readSettingsKey(cwd, key) {
  const home = os.homedir();
  const dirs = [
    join(cwd || process.cwd(), ".pi"),
    process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"),
    join(home, ".pi", "agents"),
  ];
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      const v = parsed?.[key];
      // Only plain objects are valid config; arrays/strings/numbers are misconfig.
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      // missing/unreadable settings.json is fine — try next location
    }
  }
  return undefined;
}


/**
 * Normalize a tool's "subject" — the string patterns are matched against.
 * bash → the command; read/write/edit → the raw path as the model passed it
 * (patterns are written relative, e.g. `src/*.ts`, so we do NOT resolve to
 * absolute here — external_directory handles absolute matching separately).
 */
function toolSubject(toolName, input) {
  if (toolName === "bash") return String(input?.command || "");
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return String(input?.path || "");
  }
  return "";
}

function resolve(p, cwd) {
  if (!p) return "";
  return p.startsWith("/") ? p : join(cwd || "/", p);
}

/**
 * Check whether `path` falls outside `cwd` (the external-directory boundary).
 */
function isExternal(path, cwd) {
  if (!path || !cwd) return false;
  const abs = resolve(path, cwd);
  return !abs.startsWith(resolve(cwd, "") + "/");
}

// Tools that take a path and can trigger the external_directory boundary.
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

// Tools to surface in the UI when "ask" fires.
function describe(toolName, input) {
  if (toolName === "bash") return `\`bash\`: ${input?.command || ""}`;
  if (input?.path) return `\`${toolName}\`: ${input.path}`;
  return `\`${toolName}\``;
}

export default function permissionExtension(pi) {
  // yolo mode auto-approves "ask" without prompting; explicit deny still holds.
  pi.registerFlag("yolo", {
    description: "Auto-approve all permission prompts (deny rules still enforced)",
    type: "boolean",
  });
  pi.registerFlag("auto", {
    description: "Alias for --yolo (auto-approve permission prompts)",
    type: "boolean",
  });

  // doom-loop state: ring of recent (tool, inputKey) signatures
  const recent = [];
  const DOOM_THRESHOLD = 3;

  pi.on("tool_call", async (event, ctx) => {
    // Settings.json first (production), then the legacy getSetting stub (tests).
    const rules =
      readSettingsKey(ctx?.cwd, "permission") ??
      pi.getSetting?.("permission") ??
      pi.config?.permission;
    if (!rules) return undefined; // not configured → no opinion

    const yolo = pi.getFlag("yolo") || pi.getFlag("auto");
    const { toolName, input } = event;
    const home = ctx.home || process.env.HOME || "";

    // ── Doom-loop guard ────────────────────────────────────────────────
    // Block the Nth identical consecutive call. Cheap insurance vs model loops.
    const sig = JSON.stringify({ toolName, input });
    const last3 = recent.slice(-(DOOM_THRESHOLD - 1));
    if (last3.length === DOOM_THRESHOLD - 1 && last3.every((s) => s === sig)) {
      try {
        ctx.ui.notify(`Doom-loop blocked: \`${toolName}\` repeated ${DOOM_THRESHOLD}×`, "warning");
      } catch { /* best-effort */ }
      return { block: true, reason: `doom-loop: ${toolName} repeated ${DOOM_THRESHOLD} times` };
    }
    recent.push(sig);
    if (recent.length > DOOM_THRESHOLD) recent.shift();

    // ── Rule resolution ────────────────────────────────────────────────
    // external_directory is a deny-only boundary gate: a path outside cwd is
    // blocked only if the matched external rule is "deny". Allow/null lets the
    // path through to normal tool rules (OpenCode semantics: a directory allowed
    // here inherits workspace defaults, it is not blanket-trusted).
    if (
      PATH_TOOLS.has(toolName) &&
      rules.external_directory &&
      isExternal(input?.path, ctx.cwd)
    ) {
      const subj = expandHome(input?.path || "", home);
      if (resolveRule(rules.external_directory, subj, home) === "deny") {
        return { block: true, reason: "denied by permission rule (external_directory)" };
      }
    }

    let action = null;
    let matchedRule = "(default)";

    // 1. tool-specific rules (expand ~ for path patterns so rules can reference $HOME)
    if (rules[toolName] !== undefined) {
      const toolRules = rules[toolName];
      if (typeof toolRules === "string") {
        action = toolRules;
        matchedRule = toolName + " (whole)";
      } else {
        action = resolveRule(toolRules, toolSubject(toolName, input), home);
        matchedRule = toolName;
      }
    }

    // 1b. session-scoped "Allow always" promotions: if the user previously chose
    // "Allow always this session" for this exact (tool, subject), short-circuit.
    if (action !== "allow") {
      const allowed = sessionAllowed(rules, toolName, toolSubject(toolName, input));
      if (allowed) return undefined;
    }

    // 2. global "*" default
    if (action === null && rules["*"] !== undefined) {
      action = rules["*"];
      matchedRule = "*";
    }

    // Validate action is a known verb; unknown values (e.g. an object placed at
    // "*") are treated as no-opinion so a misconfig can't accidentally block.
    if (action !== null && action !== "allow" && action !== "ask" && action !== "deny") {
      action = null;
    }

    // No rule matched → allow (no opinion).
    if (action === null || action === "allow") return undefined;
    if (action === "deny") {
      return { block: true, reason: `denied by permission rule (${matchedRule})` };
    }

    // ── "ask" ───────────────────────────────────────────────────────────
    if (yolo) return undefined; // auto-approve

    if (!ctx.hasUI) {
      // Non-interactive: can't ask → block by default (fail closed).
      return { block: true, reason: `requires approval (no UI): ${matchedRule}` };
    }

    try {
      const choice = await ctx.ui.select(
        `Permission required (${matchedRule}):\n\n  ${describe(toolName, input)}`,
        ["Allow once", "Allow always this session", "Deny"],
      );
      if (choice === "Allow always this session") {
        // Promote to allow for this session: remember this exact (tool, subject).
        promoteToSessionAllow(rules, toolName, toolSubject(toolName, input));
        return undefined;
      }
      if (choice === "Deny") {
        return { block: true, reason: `denied by user (${matchedRule})` };
      }
      return undefined; // Allow once
    } catch {
      return { block: true, reason: `approval prompt failed (${matchedRule})` };
    }
  });

  // Reset doom-loop memory on new session so a prior session's calls don't
  // poison the new one when pi reuses the extension process.
  pi.on("session_start", () => { recent.length = 0; });
}

// Session-scoped allowlist for "Allow always" promotions. Stored on the rules
// object under a hidden key; consulted in the tool-rule resolution path.
function promoteToSessionAllow(rules, toolName, subject) {
  if (!rules.__sessionAllows) rules.__sessionAllows = {};
  if (!rules.__sessionAllows[toolName]) rules.__sessionAllows[toolName] = new Set();
  rules.__sessionAllows[toolName].add(subject);
}

function sessionAllowed(rules, toolName, subject) {
  return rules.__sessionAllows?.[toolName]?.has(subject) === true;
}
