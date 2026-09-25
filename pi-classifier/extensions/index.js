/**
 * pi-classifier — System One decision models (TypeSafe Jev) for Pi.
 *
 * Decision models return typed answers with probabilities, never text — so
 * they surface as TOOLS, never chat models. Two pieces:
 *
 * 1. `classify` tool: the agent sends {state, questions}, gets typed answers.
 * 2. Opt-in permission auto-approve hook: shell commands that Jev is
 *    confident are reversible AND serve the task run without prompting.
 *    Static RISKY list first; never auto-denies; every failure falls back to
 *    the normal prompt. Default OFF; "observe" mode logs would-be decisions.
 *
 * Zero deps in the hot path, plain JS (pi-budget pattern). The /classifier-config
 * panel uses @bacnh85/pi-config-panel (declared dependency — the repo-wide
 * config-panel kernel, don't fork the TUI shell). Exports the decision helpers
 * for the test suite.
 *
 * Config (`classifier` key in ~/.pi/agent/settings.json — global only, no
 * repo scope: the endpoint receives the API key as Bearer):
 *
 *   "classifier": {
 *     "baseUrl": "https://router.example/v1",   // yardmaster or OpenRouter
 *     "model": "jev/jev-latest",                // id as the upstream knows it
 *     "permission": {                            // opt-in, default off
 *       "enabled": true,
 *       "threshold": 0.9,                        // both nouls must clear it
 *       "mode": "observe" | "enforce"            // default "observe"
 *     },
 *     "planGate": {                              // opt-in, default off — see planGateVerdict
 *       "enabled": true,
 *       "mode": "observe" | "enforce",           // default "observe"
 *       "threshold": 0.9                         // independent of permission.threshold
 *     }
 *   }
 *
 * The module is side-effect-free (tools/hooks register only inside the default
 * export), so it doubles as a library: pi-plan imports `planGateVerdict` for
 * its plan-mode confirm tier.
 *
 * API key: CLASSIFIER_API_KEY env, else auth.json `classifier` credential
 * (same file Pi's /login writes; set it manually or via `/login classifier`
 * convention). No repo-scope sources, ever.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
// Static import, like every pi-config-panel consumer (pi-router/pi-commandcode/
// pi-a2a): Pi's jiti loader transforms the TS entrypoint, but a DYNAMIC import()
// escapes to native Node ESM — which refuses type-stripping under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) and made /classifier-config
// report "not installed" on a healthy install. Declared dependency + lockfile
// make the static import always resolvable.
import { openConfigPanel, row } from "@bacnh85/pi-config-panel";

const RISKY = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/, // rm -rf
  /\bsudo\b/, /\bdoas\b/,
  /\bgit\s+push\b[^|;&]*--force/, /\bgit\s+push\s+-f\b/, /\bgit\s+reset\s+--hard\b/,
  /curl[^|;&]*\|\s*(ba)?sh/, /wget[^|;&]*\|\s*(ba)?sh/, // pipe-to-shell
  /\b(npm|pnpm|yarn|bun)\s+publish\b/, /\bgh\s+release\s+(create|upload)\b/,
  /\bterraform\s+(apply|destroy)\b/, /\bkubectl\s+(delete|apply)\b/,
  /(^|\s)~?\/?\.?(ssh|aws|gnupg|kube)(\/|$)/, /id_rsa|\.pem\b|credentials\b/i,
];

/** True when the command matches the static risk list — never sent to Jev.
 *  Exported for tests. Intentionally shallow: a new RISKY shape = new entry. */
export function isRisky(command) {
  return RISKY.some((re) => re.test(command));
}

/** Settings: global agent dir only. No repo scope — the Bearer key must not
 *  follow untrusted checkouts. Defaults render a working panel on a fresh
 *  install (pi-subagent pattern): baseUrl falls back to the configured
 *  `router.baseUrl` (same yardmaster serves both wires) and the model to
 *  jev/jev-latest. Exported for tests. */
export function getClassifierSettings() {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  } catch { /* no settings file — defaults below */ }
  const c = raw.classifier && typeof raw.classifier === "object" ? raw.classifier : {};
  const perm = c.permission && typeof c.permission === "object" ? c.permission : {};
  const pg = c.planGate && typeof c.planGate === "object" ? c.planGate : {};
  const threshold = typeof perm.threshold === "number" && perm.threshold > 0 && perm.threshold < 1
    ? perm.threshold : 0.9;
  const pgThreshold = typeof pg.threshold === "number" && pg.threshold > 0 && pg.threshold < 1
    ? pg.threshold : 0.9;
  const routerBase = typeof raw.router?.baseUrl === "string" ? raw.router.baseUrl.replace(/\/+$/, "") : "";
  return {
    baseUrl: typeof c.baseUrl === "string" && c.baseUrl ? c.baseUrl.replace(/\/+$/, "") : routerBase,
    model: typeof c.model === "string" && c.model ? c.model : "jev/jev-latest",
    permission: {
      // ponytail: default ON/enforce per owner decision after a 102-verdict
      // live audit (0 dangerous approvals) — but a no-op until baseUrl+key
      // resolve: classify() throws and the hook falls back to the prompt.
      // Explicit enabled:false in settings.json still wins.
      enabled: perm.enabled !== false,
      threshold,
      mode: perm.mode === "observe" ? "observe" : "enforce",
    },
    planGate: {
      enabled: pg.enabled === true,
      threshold: pgThreshold,
      mode: pg.mode === "enforce" ? "enforce" : "observe",
    },
  };
}

/** API key: CLASSIFIER_API_KEY env, else auth.json `classifier` credential,
 *  else the `router` credential — but ONLY when classifier.baseUrl is unset or
 *  shares the router's host (yardmaster serves both wires with one key; never
 *  let the router key silently follow classifier.baseUrl to a third party). */
export function getApiKey(s = getClassifierSettings()) {
  if (process.env.CLASSIFIER_API_KEY) return process.env.CLASSIFIER_API_KEY;
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    const key = auth?.classifier?.key;
    if (typeof key === "string" && key) return key;
    const routerKey = auth?.router?.key;
    if (typeof routerKey === "string" && routerKey && sameHost(s.baseUrl, readRouterBaseUrl(dir))) {
      return routerKey;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sameHost(a, b) {
  const host = (u) => {
    try { return new URL(u).host; } catch { return ""; }
  };
  const ha = host(a);
  return ha !== "" && ha === host(b);
}

function readRouterBaseUrl(dir) {
  try {
    const r = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))?.router?.baseUrl;
    return typeof r === "string" ? r : "";
  } catch {
    return "";
  }
}

/** Read-modify-write non-secret `classifier` fields into the GLOBAL
 *  settings.json (merge, never clobber) — writeRouterSection pattern
 *  (pi-router). Global only: the Bearer key must not follow untrusted
 *  checkouts. Atomicity (tmp+rename) is part of the contract. */
export function writeClassifierSection(patch) {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const settingsPath = join(dir, "settings.json");
  let settings = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    }
  } catch {
    // Corrupt ≠ missing: writing here would replace the whole file with ONLY
    // the classifier section — bail instead.
    throw new Error(`${settingsPath} is not valid JSON — fix or remove it before saving.`);
  }
  if (typeof settings !== "object" || settings === null) settings = {};
  const c = settings.classifier && typeof settings.classifier === "object" ? settings.classifier : {};
  if (patch.baseUrl !== undefined) c.baseUrl = String(patch.baseUrl).replace(/\/+$/, "");
  if (patch.model !== undefined) c.model = String(patch.model);
  const perm = c.permission && typeof c.permission === "object" ? c.permission : {};
  if (patch.enabled !== undefined) perm.enabled = patch.enabled === true;
  if (patch.mode !== undefined) perm.mode = patch.mode === "enforce" ? "enforce" : "observe";
  if (patch.threshold !== undefined) {
    const t = Number(patch.threshold);
    perm.threshold = t > 0 && t < 1 ? t : 0.9;
  }
  c.permission = perm;
  const pg = c.planGate && typeof c.planGate === "object" ? c.planGate : {};
  if (patch.planGateEnabled !== undefined) pg.enabled = patch.planGateEnabled === true;
  if (patch.planGateMode !== undefined) pg.mode = patch.planGateMode === "enforce" ? "enforce" : "observe";
  if (patch.planGateThreshold !== undefined) {
    const t = Number(patch.planGateThreshold);
    pg.threshold = t > 0 && t < 1 ? t : 0.9;
  }
  c.planGate = pg;
  settings.classifier = c;
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = settingsPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, settingsPath);
}

/** Pull decision-model ids from a yardmaster router: GET {base}/systemone/models.
 *  Returns string[]; 404/401/network/malformed → [] (fail-open — OpenRouter and
 *  TypeSafe direct lack the endpoint, manual model entry must keep working). */
export async function listDecisionModels({ baseUrl, apiKey }) {
  if (!baseUrl) return [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/systemone/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ac.signal,
    });
    if (!res.ok) return [];
    const body = await res.json();
    const ids = (body?.data ?? [])
      .map((m) => (typeof m?.id === "string" ? m.id : ""))
      .filter(Boolean);
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Ask Jev `questions` about `state`. Single attempt, 8s timeout — any
 *  failure throws and the caller falls back. Exported for tests. */
export async function classify({ baseUrl, model, apiKey, signal }, state, questions) {
  if (!baseUrl) throw new Error("classifier baseUrl not configured");
  if (!apiKey) throw new Error("classifier API key not configured (CLASSIFIER_API_KEY or auth.json classifier.key)");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
  try {
    const res = await fetch(`${baseUrl}/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, state, questions }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`classifier http ${res.status}`);
    const body = await res.json();
    if (!body.answers || typeof body.answers !== "object") {
      throw new Error("classifier response missing answers");
    }
    return body.answers;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a noul probability. Malformed/missing/out-of-range → NaN → fail-safe. */
export function noul(answers, id) {
  const a = answers?.[id];
  const v = a && typeof a === "object" ? a.noul : a;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : NaN;
}

/** LRU verdict cache — repeated `bun test` shouldn't re-pay Jev every time.
 *  ponytail: insertion-order map, cap 100; hash the key only if this shows up
 *  in profiles. Exported for tests. */
export function createVerdictCache(cap = 100) {
  const m = new Map();
  return {
    get(k) {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k);
      m.set(k, v); // refresh recency
      return v;
    },
    set(k, v) {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      if (m.size > cap) m.delete(m.keys().next().value);
    },
  };
}

/** Audit line per decision. Best-effort: never throws into the tool path.
 *  Exported for library hosts (pi-plan tags its entries `source: "plan-gate"`). */
export function audit(entry) {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "classifier.log"), JSON.stringify({ ts: Date.now(), pid: process.pid, ppid: process.ppid, ...entry }) + "\n");
  } catch { /* logging must never break the command */ }
}

/** Split a compound command into top-level segments the RISKY check can see.
 *  ponytail: split on operators only — a separator inside quotes can only ADD
 *  a prompt, never hide a command (OpenRouter cookbook principle). */
function segments(command) {
  return String(command).split(/&&|\|\||[;|&]|`|\$\(/).map((s) => s.trim()).filter(Boolean);
}

/** Plan-mode confirm-tier gate (called by pi-plan). The host asks ONLY about
 *  commands it classified "confirm" — never "read" (allowed) or "write"
 *  (blocked upstream) — so Jev can only ever reduce prompts, never unlock a
 *  write and never deny: a confident yes returns allow (enforce mode only);
 *  every other outcome — disabled, risky, low score, error — returns
 *  `{ allow: false }` and the host falls back to its normal prompt.
 *
 *  Cache stores `{confident, read_only, serves_plan}` — not `allow` — so a
 *  mid-session observe→enforce flip applies to cached verdicts too. Cache key
 *  is `plan\0command\0cwd`; the task is deliberately excluded (plan commands
 *  are generic). */
const planGateCache = createVerdictCache();

export async function planGateVerdict({ signal } = {}, command, cwd, task) {
  const s = getClassifierSettings();
  if (!s.planGate.enabled) return { allow: false, reason: "disabled" };
  if (isRisky(command) || segments(command).some(isRisky)) {
    return { allow: false, reason: "risky" };
  }
  const cacheKey = `plan\u0000${command}\u0000${cwd}`;
  const cached = planGateCache.get(cacheKey);
  const verdict = cached ?? await (async () => {
    const apiKey = getApiKey(s);
    const state = {
      command,
      cwd,
      context: "plan mode — researching the codebase to produce an implementation plan; filesystem mutations are forbidden by the outer gate",
      ...(task ? { task } : {}),
    };
    const questions = {
      read_only: {
        type: "noul",
        instructions: "Does this shell command only read — does it leave no file, directory, or git-state change behind?",
        criteria: { yes: "Inspecting files, history, or processes without changing them.", no: "Writes, deletes, moves, installs, or otherwise mutates anything." },
      },
      serves_plan: {
        type: "noul",
        instructions: "Is this command plausibly needed to research the codebase for an implementation plan?",
        criteria: { yes: "A reasonable research step toward a plan.", no: "Unrelated work the plan never needed." },
      },
    };
    const started = Date.now();
    try {
      const answers = await classify({ ...s, apiKey, signal }, state, questions);
      const ro = noul(answers, "read_only");
      const sp = noul(answers, "serves_plan");
      const confident = ro >= s.planGate.threshold && sp >= s.planGate.threshold;
      const v = { confident, read_only: ro, serves_plan: sp };
      planGateCache.set(cacheKey, v);
      audit({ source: "plan-gate", command, cwd, ...v, ms: Date.now() - started, model: s.model });
      return v;
    } catch (e) {
      audit({ source: "plan-gate", command, cwd, error: String(e && e.message || e), ms: Date.now() - started, model: s.model });
      return { confident: false, reason: "error" };
    }
  })();
  return {
    allow: s.planGate.mode === "enforce" && verdict.confident === true,
    read_only: verdict.read_only,
    serves_plan: verdict.serves_plan,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}

export default function (pi) {
  // ── 1. classify tool ────────────────────────────────────────────────────
  // TypeBox without the import: JSON-schema-compatible plain object works for
  // tools registered at runtime (pi validates against the schema shape).
  let Type;
  try { Type = require("@earendil-works/pi-ai").Type; } catch { Type = null; }

  const stateSchema = Type
    ? Type.Any({ description: "Everything Jev should judge: transcript, records, policy — as JSON." })
    : { description: "Everything Jev should judge: transcript, records, policy — as JSON." };
  const questionsSchema = Type
    ? Type.Array(
        Type.Object({
          id: Type.String({ description: "Answer key, e.g. 'is_urgent'" }),
          type: Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")]),
          instructions: Type.String({ description: "The question about the state." }),
          criteria: Type.Optional(Type.Any({ description: "choice: {option: description} · score: [levels] · noul: {yes,no}" })),
        }),
        { description: "One entry per independent judgment. They run in parallel and cannot see each other's answers." },
      )
    : { type: "array" };

  pi.registerTool({
    name: "classify",
    label: "Classify",
    description:
      "Ask a System One decision model (TypeSafe Jev) typed questions about a state and get calibrated answers: " +
      "noul (probability of yes), choice (option + per-option probabilities + confidence), score (weighted position + confidence). " +
      "Use for routing, verification, and gating decisions where a predictable typed answer beats generated prose. " +
      "Not for open-ended questions — decisions only, no explanations.",
    parameters: Type
      ? Type.Object({ state: stateSchema, questions: questionsSchema })
      : { type: "object", properties: { state: stateSchema, questions: questionsSchema } },
    async execute(_id, params, signal) {
      const s = getClassifierSettings();
      const qs = {};
      for (const q of params.questions ?? []) {
        let criteria = q.criteria;
        // score criteria must be a LIST upstream — an object-shaped criteria
        // (easy to produce from a JSON-schema mindset) gets 422 from Jev, so
        // coerce {"0":"low",...} to ["low",...] before sending.
        if (q.type === "score" && criteria && !Array.isArray(criteria) && typeof criteria === "object") {
          criteria = Object.keys(criteria).sort((a, b) => Number(a) - Number(b)).map((k) => criteria[k]);
        }
        qs[q.id] = { type: q.type, instructions: q.instructions, ...(criteria !== undefined ? { criteria } : {}) };
      }
      const answers = await classify({ ...s, apiKey: getApiKey(s), signal }, params.state, qs);
      return {
        content: [{ type: "text", text: JSON.stringify(answers, null, 2) }],
        details: { answers },
      };
    },
  });

  // ── 2. permission auto-approve hook (opt-in, default off) ──────────────
  let lastTask = "";
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg?.role === "user" && typeof msg.content === "string") lastTask = msg.content.slice(0, 4000);
  });

  const cache = createVerdictCache();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String(event.input?.command || "");
    if (!command) return undefined;

    const s = getClassifierSettings();
    if (!s.permission.enabled) return undefined;

    // static list first — credential-touching / irreversible commands never
    // reach Jev and never leave the normal prompt
    if (segments(command).some(isRisky)) return undefined;

    const cacheKey = `${command}\u0000${ctx.cwd}`;
    const cached = cache.get(cacheKey);

    const decide = async () => {
      const s = getClassifierSettings();
      const apiKey = getApiKey(s);
      const state = {
        command,
        project_path: ctx.cwd,
        ...(lastTask ? { task: lastTask } : {}),
      };
      const questions = {
        reversible: { type: "noul", instructions: "Can this shell command be undone — its effects reversed or discarded without lasting harm?" },
        ...(state.task ? {
          serves_task: {
            type: "noul",
            instructions: "Does this command plausibly serve the task the user asked for?",
            criteria: { yes: "A reasonable step toward the user's stated task.", no: "Unrelated to the task, or only a step the task never needed." },
          },
        } : {}),
      };
      const started = Date.now();
      try {
        const answers = await classify({ ...s, apiKey }, state, questions);
        const rev = noul(answers, "reversible");
        const serves = state.task ? noul(answers, "serves_task") : rev; // no task → reversibility only
        const ok = rev >= s.permission.threshold && serves >= s.permission.threshold;
        const decision = { approve: ok, reversible: rev, serves_task: serves };
        cache.set(cacheKey, decision);
        audit({ command, ...decision, ms: Date.now() - started, model: s.model });
        return decision;
      } catch (e) {
        audit({ command, error: String(e && e.message || e), ms: Date.now() - started, model: s.model });
        return null; // fail-safe: fall back to the normal prompt
      }
    };

    const decision = cached !== undefined ? cached : await decide();

    // Observe: log the would-be decision, always fall through. (decide() already audited.)
    if (s.permission.mode !== "enforce") return undefined;

    // Enforce: confident yes → silent allow (undefined). Everything else —
    // low score, Jev error, missing key — leaves the normal prompt. NEVER deny.
    if (decision?.approve) {
      try { ctx.ui.notify(`classifier auto-approved: ${command.slice(0, 80)}`, "info"); } catch { /* non-tui */ }
      return undefined;
    }
    return undefined; // fall through to Pi's normal flow (pi-permission ask, etc.)
  });

  // ── 3. /classifier-config — config panel + model discovery ─────────────
  const configSummary = async (s) => {
    const apiKey = getApiKey(s);
    const key = process.env.CLASSIFIER_API_KEY
      ? "set (CLASSIFIER_API_KEY env)"
      : apiKey ? "set (auth.json)" : "MISSING — set CLASSIFIER_API_KEY or auth.json classifier.key (router key reused when baseUrl matches router)";
    const models = await listDecisionModels({ baseUrl: s.baseUrl, apiKey });
    return [
      "Classifier config:",
      `  baseUrl: ${s.baseUrl || "(not configured)"}`,
      `  model: ${s.model}`,
      `  permission: ${s.permission.enabled ? "enabled" : "disabled"} · ${s.permission.mode} · threshold ${s.permission.threshold}`,
      `  planGate: ${s.planGate.enabled ? "enabled" : "disabled"} · ${s.planGate.mode} · threshold ${s.planGate.threshold} (pi-plan plan-mode confirm tier)`,
      `  apiKey: ${key}`,
      models.length ? `  decision models on router: ${models.join(", ")}` : "  decision models on router: (discovery unavailable — /v1/systemone/models 404 or unreachable)",
      "",
      "Interactive editor: run /classifier-config in TUI mode.",
    ].join("\n");
  };

  pi.registerCommand("classifier-config", {
    description: "Configure classifier endpoint/model/permission interactively (TUI) or show config",
    handler: async (args, ctx) => {
      const sub = String(args ?? "").trim().toLowerCase();
      if (sub === "show" || ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(await configSummary(getClassifierSettings()), "info");
        return;
      }

      const before = getClassifierSettings();
      const working = structuredClone(before);
      const apiKey = getApiKey(working);
      const modelIds = await listDecisionModels({ baseUrl: working.baseUrl, apiKey });

      await openConfigPanel({
        ctx,
        cfg: working,
        title: "Classifier Configuration",
        build: (cfg) => [
          {
            key: "endpoint",
            label: "Endpoint",
            rows: [
              row("baseUrl", "Base URL", "string", cfg.baseUrl, (v) => {
                cfg.baseUrl = String(v ?? "").trim();
              }),
            ],
          },
          {
            key: "model",
            label: "Decision model",
            rows: [
              row("model", "Model", "string", cfg.model, (v) => {
                cfg.model = String(v ?? "").trim() || "jev/jev-latest";
              }, modelIds.length
                ? { completions: () => modelIds.map((id) => ({ value: id })) }
                : {}),
            ],
          },
          {
            key: "permission",
            label: "Permission auto-approve",
            rows: [
              row("enabled", "Enabled", "toggle", cfg.permission.enabled, (v) => {
                cfg.permission.enabled = Boolean(v);
              }),
              row("mode", "Enforce (vs observe)", "toggle", cfg.permission.mode === "enforce", (v) => {
                cfg.permission.mode = v === true ? "enforce" : "observe";
              }),
              // ponytail: string row + parseFloat — the kernel's number rows
              // coerce via toInt/parseInt, which would truncate 0.9 → 0
              row("threshold", "Threshold (0-1)", "string", String(cfg.permission.threshold), (v) => {
                cfg.permission.threshold = parseFloat(String(v)) || cfg.permission.threshold;
              }),
            ],
          },
          {
            key: "planGate",
            label: "Plan-mode gate (pi-plan)",
            rows: [
              row("pgEnabled", "Enabled", "toggle", cfg.planGate.enabled, (v) => {
                cfg.planGate.enabled = Boolean(v);
              }),
              row("pgMode", "Enforce (vs observe)", "toggle", cfg.planGate.mode === "enforce", (v) => {
                cfg.planGate.mode = v === true ? "enforce" : "observe";
              }),
              row("pgThreshold", "Threshold (0-1)", "string", String(cfg.planGate.threshold), (v) => {
                cfg.planGate.threshold = parseFloat(String(v)) || cfg.planGate.threshold;
              }),
            ],
          },
        ],
        onSave: async (saved) => {
          if (!saved) return;
          const changed =
            working.baseUrl !== before.baseUrl ||
            working.model !== before.model ||
            working.permission.enabled !== before.permission.enabled ||
            working.permission.mode !== before.permission.mode ||
            working.permission.threshold !== before.permission.threshold ||
            working.planGate.enabled !== before.planGate.enabled ||
            working.planGate.mode !== before.planGate.mode ||
            working.planGate.threshold !== before.planGate.threshold;
          if (!changed) {
            ctx.ui.notify("No changes.", "info");
            return;
          }
          try {
            writeClassifierSection({
              baseUrl: working.baseUrl !== before.baseUrl ? working.baseUrl : undefined,
              model: working.model !== before.model ? working.model : undefined,
              enabled: working.permission.enabled !== before.permission.enabled ? working.permission.enabled : undefined,
              mode: working.permission.mode !== before.permission.mode ? working.permission.mode : undefined,
              threshold: working.permission.threshold !== before.permission.threshold ? working.permission.threshold : undefined,
              planGateEnabled: working.planGate.enabled !== before.planGate.enabled ? working.planGate.enabled : undefined,
              planGateMode: working.planGate.mode !== before.planGate.mode ? working.planGate.mode : undefined,
              planGateThreshold: working.planGate.threshold !== before.planGate.threshold ? working.planGate.threshold : undefined,
            });
          } catch (err) {
            ctx.ui.notify(`Not saved: ${err instanceof Error ? err.message : String(err)}`, "error");
            return;
          }
          const s = getClassifierSettings();
          ctx.ui.notify(
            `Classifier config saved. ${s.baseUrl || "(no baseUrl)"} · model ${s.model} · permission ${s.permission.enabled ? "enabled" : "disabled"} (${s.permission.mode}, threshold ${s.permission.threshold}) · plan gate ${s.planGate.enabled ? "enabled" : "disabled"} (${s.planGate.mode}, threshold ${s.planGate.threshold})`,
            "info",
          );
        },
      });
    },
  });
}
