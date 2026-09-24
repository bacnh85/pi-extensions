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
 * Zero deps, plain JS (pi-budget pattern). Exports the decision helpers for
 * the test suite.
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
 *     }
 *   }
 *
 * API key: CLASSIFIER_API_KEY env, else auth.json `classifier` credential
 * (same file Pi's /login writes; set it manually or via `/login classifier`
 * convention). No repo-scope sources, ever.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 *  follow untrusted checkouts. Exported for tests. */
export function getClassifierSettings() {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  } catch { /* no settings file — defaults below */ }
  const c = raw.classifier && typeof raw.classifier === "object" ? raw.classifier : {};
  const perm = c.permission && typeof c.permission === "object" ? c.permission : {};
  const threshold = typeof perm.threshold === "number" && perm.threshold > 0 && perm.threshold < 1
    ? perm.threshold : 0.9;
  return {
    baseUrl: typeof c.baseUrl === "string" ? c.baseUrl.replace(/\/+$/, "") : "",
    model: typeof c.model === "string" && c.model ? c.model : "jev/jev-latest",
    permission: {
      enabled: perm.enabled === true,
      threshold,
      mode: perm.mode === "enforce" ? "enforce" : "observe",
    },
  };
}

/** API key: CLASSIFIER_API_KEY env, else auth.json `classifier` credential. */
export function getApiKey() {
  if (process.env.CLASSIFIER_API_KEY) return process.env.CLASSIFIER_API_KEY;
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    const key = auth?.classifier?.key;
    return typeof key === "string" && key ? key : undefined;
  } catch {
    return undefined;
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

/** Audit line per decision. Best-effort: never throws into the tool path. */
function audit(entry) {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "classifier.log"), JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch { /* logging must never break the command */ }
}

/** Split a compound command into top-level segments the RISKY check can see.
 *  ponytail: split on operators only — a separator inside quotes can only ADD
 *  a prompt, never hide a command (OpenRouter cookbook principle). */
function segments(command) {
  return String(command).split(/&&|\|\||[;|&]|`|\$\(/).map((s) => s.trim()).filter(Boolean);
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
        qs[q.id] = { type: q.type, instructions: q.instructions, ...(q.criteria !== undefined ? { criteria: q.criteria } : {}) };
      }
      const answers = await classify(s, params.state, qs);
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
      const apiKey = getApiKey();
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
}
