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

import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import * as nodePath from "node:path";
const { join: pathJoin } = nodePath;
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
  // "s" flag: `*` must cross newlines like it crosses `/` — without it,
  // multiline commands (heredocs, multi-line scripts) matched NO rule and
  // bypassed every ask/deny.
  return new RegExp("^" + re + "$", "s");
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
 * An empty home (ctx.home undefined + HOME unset) returns the pattern
 * unchanged — expanding would turn `~/x` into `/x` via join.
 * Exported for unit testing.
 */
export function expandHome(pattern, home) {
  if (!home) return pattern;
  if (pattern === "~") return home;
  if (pattern.startsWith("~/")) return pathJoin(home, pattern.slice(2));
  if (pattern.startsWith("$HOME/")) return pathJoin(home, pattern.slice(6));
  return pattern;
}

/**
 * Read a settings.json key directly from disk. The SDK's ExtensionAPI has NO
 * getSetting/config (only registerFlag/getFlag for CLI flags), so structured
 * config must be read from <cwd>/.pi/settings.json → ~/.pi/agent/settings.json,
 * first existing file wins (per-package settings readers — extract to a shared
 * helper when a fourth copy appears).
 *
 * The project scope is gated on `ctx.isProjectTrusted()`: settings.json inside
 * an untrusted checkout must not disable the user's ask/deny guardrails.
 */
export function readSettingsKey(cwd, key, { project = true } = {}) {
  const home = os.homedir();
  const dirs = [
    ...(project ? [pathJoin(cwd || process.cwd(), ".pi")] : []),
    process.env.PI_CODING_AGENT_DIR || pathJoin(home, ".pi", "agent"),
    pathJoin(home, ".pi", "agents"),
  ];
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(readFileSync(pathJoin(dir, "settings.json"), "utf8"));
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
  if (toolName === "grep" || toolName === "find" || toolName === "ls") {
    // Subject = path only (the security-relevant scope); a pattern-only
    // search spans the whole cwd — too broad to key a remember-choice on.
    return String(input?.path || "");
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return String(input?.path || "");
  }
  return "";
}

/**
 * Normalized match subjects for path tools. Rules are matched against the
 * traversal-normalized relative form AND the absolute form — never the raw
 * string: raw matching let `src/../../x` satisfy `src/*` (`*` crosses `/`,
 * `..` was never resolved) and let absolute `/proj/private/k` slip past a
 * relative `private/*` deny. Falls back to the raw string if resolution
 * throws (exotic inputs must not crash the gate).
 */
export function normalizedSubjects(raw, cwd, home) {
  const s = String(raw || "");
  if (!s.trim()) return { rel: "", abs: "" }; // subject-less call stays subject-less
  try {
    // Drive-letter input/cwd (C:\… or C:/…) resolves under path.win32 even on
    // a posix host — WSL-boundary rules and cross-platform configs stay sane.
    const P = /^[A-Za-z]:[/\\]/.test(s) || /^[A-Za-z]:[/\\]/.test(cwd || "") ? nodePath.win32 : nodePath;
    const root = P.resolve(cwd || process.cwd());
    const abs = P.resolve(root, expandHome(s, home));
    const rel = P.relative(root, abs) || ".";
    return { rel, abs };
  } catch {
    return { rel: s, abs: s };
  }
}

// Per-pattern subject selection: relative patterns match the normalized
// relative subject, absolute/~/patterns match the absolute form (keeps a
// scoped allow from being overridden by its own `*` fallback matching the
// other subject form). Insertion order + last-match-wins preserved.
function resolvePathAction(toolRules, rel, abs, home) {
  let action = null;
  for (const [pattern, val] of Object.entries(toolRules)) {
    const pat = home ? expandHome(pattern, home) : pattern;
    // Absolute = posix `/…` OR win32 drive-letter `C:\…`/`C:/…` (nodePath is
    // platform-correct in production; the drive-letter test covers rules
    // written for a Windows cwd from any host).
    const subject = pat.startsWith("/") || /^[A-Za-z]:[/\\]/.test(pat) ? abs : rel;
    if (wildcardToRegex(pat).test(subject)) action = val;
  }
  return action;
}

function resolve(p, cwd, ppath = nodePath) {
  if (!p) return "";
  // node:path resolve normalizes `..` — the old hand-rolled join left it in
  // place ("../x" → "/proj/../x"), so the isExternal prefix check classified
  // traversal paths as internal and they bypassed the deny gate.
  return ppath.resolve(cwd || ppath.sep, p);
}

/**
 * Check whether `path` falls outside `cwd` (the external-directory boundary).
 * A path exactly equal to cwd (e.g. reading the project root itself) is NOT
 * external — only strictly-outside paths are.
 *
 * Containment uses path.relative, NOT a `root + "/"` prefix check: win32
 * pathResolve yields backslash separators, so the prefix check classified
 * every path as external and external_directory deny blocked all path tools
 * (regression 0.2.5). Exported for unit testing; `ppath` (default node:path,
 * i.e. posix on posix hosts) lets tests inject `path.win32` to exercise the
 * exact code path production Windows takes.
 */
export function isExternal(path, cwd, ppath) {
  if (!path || !cwd) return false;
  const P = ppath || nodePath;
  const abs = resolve(path, cwd, P);
  const root = resolve(cwd, "", P);
  if (abs === root) return false;
  const rel = P.relative(root, abs);
  // Canonical containment idiom: `..env` (a legal workspace filename) also
  // starts with ".." but is INSIDE the root — only the exact parent rel or a
  // true `..`+separator prefix escapes it.
  return rel === ".." || rel.startsWith(".." + P.sep) || P.isAbsolute(rel);
}

// Tools that take a path and can trigger the external_directory boundary.
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

// Tools to surface in the UI when "ask" fires. Control characters are
// flattened and long commands/paths clipped so untrusted command text can't
// reshape the dialog.
function describe(toolName, input) {
  const clip = (s) => {
    const c = String(s).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
    return c.length > 120 ? c.slice(0, 120) + "…" : c;
  };
  if (toolName === "bash") return `\`bash\`: ${clip(String(input?.command || ""))}`;
  if (input?.path) return `\`${toolName}\`: ${clip(String(input.path))}`;
  return `\`${toolName}\``;
}

// Session-scoped allowlist for "Allow for this session" promotions. Module
// state — settings are re-read from disk on every tool_call, so promotions
// cannot live on the (ephemeral) rules object.
const sessionAllows = new Map(); // toolName → Set<subject>

function promoteToSessionAllow(toolName, subject) {
  if (!sessionAllows.has(toolName)) sessionAllows.set(toolName, new Set());
  sessionAllows.get(toolName).add(subject);
}

function sessionAllowed(toolName, subject) {
  return sessionAllows.get(toolName)?.has(subject) === true;
}

/**
 * Persist an "allow" rule for this exact (tool, subject) into the settings.json
 * that already carries the permission config (same resolution order as
 * readSettingsKey); if none exists, create <cwd>/.pi/settings.json.
 * Returns { file } on success or { error } on failure.
 * Exported for unit testing (dirs overrides the search list).
 */
export function persistAllowlistRule(toolName, subject, ctx, dirs) {
  try {
    // A subject bearing wildcards (e.g. `git add *`) would be stored as a
    // glob pattern far broader than what the user approved — refuse.
    if (/[\x2a\x3f]/.test(String(subject))) {
      return { error: `subject contains wildcard characters (* or ?): ${String(subject)} — add the rule manually` };
    }
    const home = os.homedir();
    const search = dirs ?? [
      pathJoin(ctx?.cwd || process.cwd(), ".pi"),
      process.env.PI_CODING_AGENT_DIR || pathJoin(home, ".pi", "agent"),
      pathJoin(home, ".pi", "agents"),
    ];
    let target = search[0];
    for (const dir of search) {
      try {
        const existing = JSON.parse(readFileSync(pathJoin(dir, "settings.json"), "utf8"));
        if (existing?.permission && typeof existing.permission === "object" && !Array.isArray(existing.permission)) {
          target = dir;
          break;
        }
      } catch { /* no/invalid settings.json here — keep looking */ }
    }
    mkdirSync(target, { recursive: true });
    const file = pathJoin(target, "settings.json");
    let parsed = {};
    try {
      const raw = readFileSync(file, "utf8");
      parsed = JSON.parse(raw);
    } catch (e) {
      if (e?.code !== "ENOENT") {
        // An existing-but-unparseable settings.json must never be overwritten.
        return { error: `settings.json at ${file} is not valid JSON; not overwriting` };
      }
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
    const perm = parsed.permission && typeof parsed.permission === "object" && !Array.isArray(parsed.permission)
      ? parsed.permission
      : {};
    const prev = perm[toolName];
    const toolRules = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
    if (typeof prev === "string") toolRules["*"] = prev; // whole-tool rule kept as `*` (inserted first, specific allow still wins)
    // Re-append the subject LAST so the explicit allow wins (last-match-wins),
    // even when the same key already existed earlier in insertion order.
    delete toolRules[String(subject)];
    toolRules[String(subject)] = "allow";
    perm[toolName] = toolRules;
    parsed.permission = perm;
    // Atomic write: temp file + rename so a crash can't truncate settings.json.
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n");
    renameSync(tmp, file);
    return { file };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/**
 * One-time-per-session warning for permission rules that parse but can never
 * match: a string-valued `external_directory` (resolveRule only handles rule
 * objects) or an unknown action verb (treated as no-opinion — the rule
 * silently no-ops). Best-effort via ctx.ui.notify; fires at most once.
 */
let warnedInvalidRules = false;
export function resetInvalidRulesWarning() {
  warnedInvalidRules = false;
}
function warnInvalidRules(rules, ctx) {
  if (warnedInvalidRules) return;
  const problems = [];
  if (typeof rules.external_directory === "string") {
    problems.push('external_directory must be a rule object ({"pattern":"action"}), not a string');
  }
  for (const [tool, r] of Object.entries(rules)) {
    // external_directory has no actions to validate (patterns outside cwd are
    // deny-only); string-shaped rules (whole-tool verb) are one value.
    const vals =
      r && typeof r === "object" && !Array.isArray(r)
        ? (tool === "external_directory" ? [] : Object.values(r))
        : [r];
    for (const v of vals) {
      if (v !== "allow" && v !== "ask" && v !== "deny") {
        problems.push(`unknown action ${JSON.stringify(v)} in "${tool}" rules`);
        break;
      }
    }
  }
  if (problems.length === 0) return;
  warnedInvalidRules = true;
  try {
    ctx?.ui?.notify(`Invalid permission rules ignored: ${problems.join("; ")}`, "warning");
  } catch { /* best-effort */ }
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

  // CLI flags are immutable after parse; capture once at load so event
  // handlers never touch the captured pi API (stale after session
  // replacement/reload — getFlag throws there).
  let yolo = false;
  let auto = false;
  try {
    yolo = Boolean(pi.getFlag("yolo"));
    auto = Boolean(pi.getFlag("auto"));
  } catch {
    yolo = false;
    auto = false;
  }

  // doom-loop state: ring of recent (tool, inputKey) signatures
  const recent = [];
  const DOOM_THRESHOLD = 3;

  // Rule resolution for a tool call: undefined = allow, { block, reason } =
  // deny. Doom-loop counting lives in the handler wrapper below.
  async function resolveCall(rules, event, ctx) {
    const { toolName, input } = event;
    const home = ctx.home || process.env.HOME || "";

    // ── Rule resolution ────────────────────────────────────────────────
    // external_directory is a deny-only boundary gate: a path outside cwd is
    // blocked only if the matched external rule is "deny". Allow/null lets the
    // path through to normal tool rules (OpenCode semantics: a directory allowed
    // here inherits workspace defaults, it is not blanket-trusted).
    if (
      PATH_TOOLS.has(toolName) &&
      rules.external_directory
    ) {
      // Expand ~ BEFORE the boundary check: on the raw path, `~/ext/file`
      // resolves relative to cwd (e.g. /proj/~/ext/file) → classified internal
      // → the deny gate never fired, while the path tool expands ~ to an
      // external file. resolveRule already expanded; the gate must too.
      // Empty home → expandHome is identity → behavior unchanged.
      const subj = expandHome(input?.path || "", home);
      if (isExternal(subj, ctx.cwd) && resolveRule(rules.external_directory, subj, home) === "deny") {
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
        if (PATH_TOOLS.has(toolName)) {
          const { rel, abs } = normalizedSubjects(input?.path, ctx.cwd, home);
          action = resolvePathAction(toolRules, rel, abs, home);
        } else {
          action = resolveRule(toolRules, toolSubject(toolName, input), home);
        }
        matchedRule = toolName;
      }
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

    // Session promotions only suppress the "ask" prompt — an explicit deny
    // (tool rule or global, possibly tightened mid-session after a re-read)
    // always wins.
    const sessionSubject = PATH_TOOLS.has(toolName)
      ? normalizedSubjects(input?.path, ctx.cwd, home).rel
      : toolSubject(toolName, input);
    if (sessionAllowed(toolName, sessionSubject)) return undefined;

    // ── "ask" ───────────────────────────────────────────────────────
    if (yolo || auto) return undefined; // auto-approve (--yolo or --auto)

    if (!ctx.hasUI) {
      // Non-interactive: can't ask → block by default (fail closed).
      return { block: true, reason: `requires approval (no UI): ${matchedRule}` };
    }

    try {
      const subject = sessionSubject;
      // Subject-less tools (no command/path to key on) get no remember options.
      const options = subject
        ? ["Allow once", "Allow for this session", "Add to permanent allowlist", "Deny"]
        : ["Allow once", "Deny"];
      const choice = await ctx.ui.select(
        `Permission required (${matchedRule}):\n\n  ${describe(toolName, input)}`,
        options,
      );
      if (choice === "Allow for this session") {
        promoteToSessionAllow(toolName, subject);
        return undefined;
      }
      if (choice === "Add to permanent allowlist") {
        // Trust gate mirrors the read path: in an untrusted project the rule
        // must land in global scope — writing cwd/.pi/settings.json would be
        // a silent no-op (that file is not read there) and modifies a
        // repo-controlled file.
        const trusted = ctx?.isProjectTrusted?.() === true;
        const written = trusted
          ? persistAllowlistRule(toolName, subject, ctx)
          : persistAllowlistRule(toolName, subject, ctx, [
              process.env.PI_CODING_AGENT_DIR || pathJoin(os.homedir(), ".pi", "agent"),
              pathJoin(os.homedir(), ".pi", "agents"),
            ]);
        if (written.error) {
          return { block: true, reason: `could not persist allowlist rule: ${written.error}` };
        }
        promoteToSessionAllow(toolName, subject); // cover the rest of this session too
        try {
          ctx.ui.notify(`Permission rule added to ${written.file}: ${describe(toolName, input)} → allow`, "info");
        } catch { /* best-effort */ }
        return undefined;
      }
      if (choice !== "Allow once") {
        // "Deny" or dismissed dialog (Esc) — fail closed.
        return { block: true, reason: `denied by user (${matchedRule})` };
      }
      return undefined; // Allow once
    } catch {
      return { block: true, reason: `approval prompt failed (${matchedRule})` };
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    // Settings.json first (production), then the legacy getSetting stub (tests).
    // Project scope is trust-gated: settings.json in an untrusted checkout must
    // not shadow the user's global rules (pi-references pattern).
    const rules =
      readSettingsKey(ctx?.cwd, "permission", {
        project: ctx?.isProjectTrusted?.() === true,
      }) ??
      pi.getSetting?.("permission") ??
      pi.config?.permission;
    if (!rules) return undefined; // not configured → no opinion
    warnInvalidRules(rules, ctx);

    // ── Doom-loop guard ────────────────────────────────────────────────
    // Block the Nth identical consecutive call. Cheap insurance vs model loops.
    // Only allowed/ask outcomes count toward the ring: repeated DENIED calls
    // must keep reporting the real deny reason, not a doom-loop mask.
    const { toolName, input } = event;
    const sig = JSON.stringify({ toolName, input });
    const last3 = recent.slice(-(DOOM_THRESHOLD - 1));
    if (last3.length === DOOM_THRESHOLD - 1 && last3.every((s) => s === sig)) {
      try {
        ctx.ui.notify(`Doom-loop blocked: \`${toolName}\` repeated ${DOOM_THRESHOLD}×`, "warning");
      } catch { /* best-effort */ }
      return { block: true, reason: `doom-loop: ${toolName} repeated ${DOOM_THRESHOLD} times` };
    }

    const result = await resolveCall(rules, event, ctx);
    if (!result?.block) {
      recent.push(sig);
      if (recent.length > DOOM_THRESHOLD) recent.shift();
    }
    return result;
  });

  // Reset doom-loop + session-allow memory on new session so a prior session's
  // calls don't poison the new one when pi reuses the extension process.
  pi.on("session_start", () => { recent.length = 0; sessionAllows.clear(); resetInvalidRulesWarning(); });
}
