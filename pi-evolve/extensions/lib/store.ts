// Storage abstraction: writes learnings to Munin (if configured) or a local
// JSONL fallback. Reuses pi-munin's config + SDK call path — pi-evolve never
// reimplements storage, only consumes it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MuninClient } from "@kalera/munin-sdk";

export interface Learning {
  kind: "strategy" | "recovery" | "optimization";
  trigger: string; // the task/symptom context this applies to
  lesson: string; // the transferable takeaway
  anchors?: string[]; // file paths, symbols, commands
}

export interface StoredLearning extends Learning {
  key: string;
  title: string;
  storedAt: string; // ISO
}

export interface StoreConfig {
  /** "munin" | "local" | "auto" (auto = munin if configured, else local). */
  store: string;
  /** Max JSONL entries (bounded at append). */
  localCap: number;
}

const DEFAULT_CONFIG: StoreConfig = { store: "auto", localCap: 500 };

export function resolveStoreConfig(raw: unknown): StoreConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const r = raw as Record<string, unknown>;
  const store = typeof r.store === "string" && ["munin", "local", "auto"].includes(r.store)
    ? r.store
    : DEFAULT_CONFIG.store;
  const localCap = typeof r.localCap === "number" && r.localCap > 0 ? r.localCap : DEFAULT_CONFIG.localCap;
  return { store, localCap };
}

// ---------------------------------------------------------------------------
// Config resolution — mirrors pi-munin's getMuninConfig but non-throwing: returns
// null when Munin is not configured so callers can fall back to local JSONL.
// ---------------------------------------------------------------------------

interface MuninResolvedConfig {
  apiKey: string;
  projectId: string;
  baseUrl: string;
}

// SECURITY (mirrors pi-munin's guards — see issue #18):
// 1. URL shape: http(s) only, no credentials, no query/fragment.
// 2. An explicit base_url override requires an explicit api_key, so an
//    attacker-controlled override can never pair with the user's real key.
// 3. cwd/.env* (incl. the parent-dir walk) is only read for trusted projects,
//    so an untrusted repo's .env can't redirect exfiltration either.
function normalizeBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Try to resolve Munin config from env/dotfiles + tool params. Null when not configured. */
export function tryResolveMunin(
  params: Record<string, unknown> = {},
  cwd = process.cwd(),
  includeCwdEnv: boolean | (() => boolean) = false,
): MuninResolvedConfig | null {
  // pi-munin's getMuninConfig mirrors this gate: cwd env files (and the
  // parent-dir walk) are only read when the project is trusted.
  const includeCwd = typeof includeCwdEnv === "function" ? includeCwdEnv() : includeCwdEnv;
  const fileEnv = loadMuninEnv(cwd, includeCwd);
  const explicitApiKey = typeof params.api_key === "string" && params.api_key ? params.api_key : undefined;
  const explicitBaseUrl = typeof params.base_url === "string" && params.base_url ? params.base_url : undefined;
  // SECURITY: a base_url override without its own api_key is ignored outright —
  // an attacker-controlled override must never pair with the user's real key.
  if (explicitBaseUrl && !explicitApiKey) return null;
  const apiKey = explicitApiKey
    || process.env.MUNIN_API_KEY
    || fileEnv.MUNIN_API_KEY;
  const projectId = (typeof params.project === "string" && params.project ? params.project : undefined)
    || process.env.MUNIN_PROJECT
    || fileEnv.MUNIN_PROJECT;
  if (!apiKey || !projectId) return null;
  const baseUrl = normalizeBaseUrl(
    explicitBaseUrl || process.env.MUNIN_BASE_URL || fileEnv.MUNIN_BASE_URL || "https://munin.kalera.ai",
  );
  if (!baseUrl) return null; // malformed URL shape — fall back to the local store
  return { apiKey, projectId, baseUrl };
}

/** Minimal dotenv loader for MUNIN_* vars — same discovery chain as pi-munin,
 *  plus a parent-dir walk so a session running inside a subdirectory of a
 *  project still finds the project root's .env.local (e.g. repo root creds
 *  when the agent cwd is a package dir). */
function loadMuninEnv(cwd: string, includeCwd: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  const dirs = process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
  const candidates = [
    ...(includeCwd ? [path.resolve(cwd, ".env.local"), path.resolve(cwd, ".env")] : []),
    ...(includeCwd ? parentEnvCandidates(cwd) : []),
    ...dirs.flatMap((d) => [path.join(d, ".env.local"), path.join(d, ".env")]),
  ];
  for (const file of candidates) {
    try {
      const content = readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      // missing env file is fine
    }
  }
  return env;
}

/** Walk parent directories looking for .env.local / .env (project root discovery).
 *  ponytail: bounded — stops at the filesystem root; first existing file wins. */
function parentEnvCandidates(cwd: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    out.push(path.join(parent, ".env.local"), path.join(parent, ".env"));
    dir = parent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Decide the active backend given resolved config + user preference. */
export function activeBackend(params: Record<string, unknown>, cfg: StoreConfig, cwd: string, trusted?: boolean): "munin" | "local" {
  const munin = tryResolveMunin(params, cwd, trusted === true);
  if (cfg.store === "local") return "local";
  if (cfg.store === "munin") return munin ? "munin" : "local";
  return munin ? "munin" : "local"; // auto
}

/** Persist a learning. Returns the stored record (with key). */
export async function writeLearning(
  learning: Learning,
  params: Record<string, unknown>,
  cfg: StoreConfig,
  cwd: string,
  trusted?: boolean,
): Promise<StoredLearning> {
  const key = makeKey(learning);
  const title = `[${learning.kind}] ${learning.trigger}`.slice(0, 120);
  const content = formatLearningContent(learning);
  const tags = `type:learning,domain:${inferDomain(learning)}`;
  // The Munin SDK expects tags as an array (client.store does tags.join()); the
  // local JSONL keeps the comma-joined string for compactness. Split per backend.
  const muninTags = tags.split(",");
  const storedAt = new Date().toISOString();

  const backend = activeBackend(params, cfg, cwd);
  if (backend === "munin") {
    const munin = tryResolveMunin(params, cwd, trusted === true)!;
    const client = new MuninClient({ apiKey: munin.apiKey, baseUrl: munin.baseUrl });
    // ponytail: direct store() — no capability dance; if it throws, caller handles.
    if (typeof (client as any).store === "function") {
      await (client as any).store(munin.projectId, { key, title, content, tags: muninTags });
    } else if (typeof (client as any).invoke === "function") {
      await (client as any).invoke(munin.projectId, "store", { key, title, content, tags: muninTags }, { ensureCapability: true });
    } else {
      throw new Error("Munin SDK exposes neither store() nor invoke()");
    }
  } else {
    const file = localPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ key, title, content, tags, storedAt }) + "\n", "utf8");
    capLocal(file, cfg.localCap);
  }
  return { ...learning, key, title, storedAt };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Read recent learnings for injection. Munin path uses 'recent' action; local reads tail of JSONL. */
export async function readRecentLearnings(
  n: number,
  params: Record<string, unknown>,
  cfg: StoreConfig,
  cwd: string,
  trusted?: boolean,
): Promise<StoredLearning[]> {
  const backend = activeBackend(params, cfg, cwd);
  if (backend === "munin") {
    const munin = tryResolveMunin(params, cwd, trusted === true)!;
    const client = new MuninClient({ apiKey: munin.apiKey, baseUrl: munin.baseUrl });
    let result: unknown;
    try {
      if (typeof (client as any).recent === "function") {
        result = await (client as any).recent(munin.projectId, { limit: n, tags: ["type:learning"] });
      } else if (typeof (client as any).invoke === "function") {
        result = await (client as any).invoke(munin.projectId, "recent", { limit: n, tags: ["type:learning"] }, { ensureCapability: true });
      }
    } catch {
      return []; // injection is best-effort; never break the session on read failure
    }
    return parseMuninMemories(result);
  }
  return readLocalTail(localPath(cwd), n);
}

// ---------------------------------------------------------------------------
// Search (similarity-keyed injection)
// ---------------------------------------------------------------------------

/**
 * Search learnings relevant to a prompt (similarity-keyed injection).
 * Munin path uses the semantic 'search' action; local path scores keyword overlap.
 */
export async function searchLearnings(
  query: string,
  n: number,
  params: Record<string, unknown>,
  cfg: StoreConfig,
  cwd: string,
  trusted?: boolean,
): Promise<StoredLearning[]> {
  const backend = activeBackend(params, cfg, cwd);
  if (backend === "munin") {
    const munin = tryResolveMunin(params, cwd, trusted === true)!;
    const client = new MuninClient({ apiKey: munin.apiKey, baseUrl: munin.baseUrl });
    let result: unknown;
    try {
      if (typeof (client as any).search === "function") {
        result = await (client as any).search(munin.projectId, { query, topK: n, tags: ["type:learning"] });
      } else if (typeof (client as any).invoke === "function") {
        result = await (client as any).invoke(munin.projectId, "search", { query, topK: n, tags: ["type:learning"] }, { ensureCapability: true });
      }
    } catch {
      return []; // best-effort
    }
    return parseMuninMemories(result);
  }
  // Local: keyword-overlap scoring against JSONL entries.
  const all = readAllLocal(localPath(cwd));
  return rankLocal(all, query).slice(0, n);
}

/** Read ALL local entries (for ranking).
 *  ponytail: full-scan is fine at localCap default 500; avoid raising localCap
 *  beyond ~5000 without a streaming ranker. */
function readAllLocal(file: string): StoredLearning[] {
  if (!existsSync(file)) return [];
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: StoredLearning[] = [];
  for (const line of content.split("\n").filter((l) => l.trim())) {
    try {
      out.push(fromStoredJson(JSON.parse(line)));
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Tokenize into lowercase word stems (alphanumeric runs only).
 *  ponytail: 1000-token bound — far beyond any real query/learning, avoids
 *  pathological inputs dominating the Set. */
function tokenize(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 1000));
}

/** Score learnings by query-keyword overlap (trigger + lesson + anchors). */
export function rankLocal(learnings: StoredLearning[], query: string): StoredLearning[] {
  const q = tokenize(query);
  if (q.size === 0) return learnings;
  const scored = learnings.map((l) => {
    const triggerTok = tokenize(l.trigger);
    const hay = tokenize(`${l.trigger} ${l.lesson} ${(l.anchors ?? []).join(" ")}`);
    // Title tokens ("[kind] trigger") overlap the trigger; bonus only for
    // tokens NOT already in the trigger/lesson/anchors haystack, so trigger
    // words are never double-counted.
    const titleBonusTok = tokenize(l.title);
    let score = 0;
    for (const t of q) {
      if (hay.has(t)) score++;
      else if (titleBonusTok.has(t) && !triggerTok.has(t)) score++;
    }
    return { l, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.l);
}

// ---------------------------------------------------------------------------
// Local JSONL helpers
// ---------------------------------------------------------------------------

export function localPath(cwd: string): string {
  return path.join(cwd, ".pi", "evolve", "learnings.jsonl");
}

/** Read the last n entries from a JSONL file. Tolerates malformed trailing lines. */
export function readLocalTail(file: string, n: number): StoredLearning[] {
  if (!existsSync(file)) return [];
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-n);
  const out: StoredLearning[] = [];
  for (const line of tail) {
    try {
      const obj = JSON.parse(line);
      out.push(fromStoredJson(obj));
    } catch {
      // skip malformed
    }
  }
  return out;
}

/** Cap the JSONL file to the last `cap` lines (bounded at append). */
export function capLocal(file: string, cap: number): void {
  if (!existsSync(file)) return;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length <= cap) return;
  // Rewrite with the tail. ponytail: read+rewrite on append — fine for a local scratch file at ≤500 lines.
  try {
    writeFileSync(file, lines.slice(-cap).join("\n") + "\n", "utf8");
  } catch {
    // best-effort; if rewrite fails, leave the file (it'll be re-capped next append)
  }
}

function fromStoredJson(obj: Record<string, unknown>): StoredLearning {
  // Learnings are stored as {key,title,content,tags,storedAt}; content embeds kind/trigger/lesson/anchors.
  const content = String(obj.content ?? "");
  const parsed = parseLearningContent(content);
  return {
    kind: (parsed.kind as Learning["kind"]) ?? "strategy",
    trigger: parsed.trigger ?? String(obj.title ?? ""),
    lesson: parsed.lesson ?? content,
    anchors: parsed.anchors,
    key: String(obj.key ?? ""),
    title: String(obj.title ?? ""),
    storedAt: String(obj.storedAt ?? new Date(0).toISOString()),
  };
}

/** Parse Munin search/recent result into StoredLearning[]. Tolerates {data:[...]} and raw arrays. */
function parseMuninMemories(result: unknown): StoredLearning[] {
  if (!result || typeof result !== "object") return [];
  const container = result as Record<string, unknown>;
  let data = container.data ?? container.items ?? container.result ?? result;
  const nested = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
  if (Array.isArray(nested?.memories)) data = nested!.memories;
  const items = Array.isArray(data) ? data.filter(Boolean) : [data].filter(Boolean);
  return items.map((it) => fromStoredJson((it as Record<string, unknown>) ?? {})).filter((l) => l.lesson);
}

// ---------------------------------------------------------------------------
// Learning content format (structured for both storage + round-trip parse)
// ---------------------------------------------------------------------------

/** Collapse internal newlines so format/parse round-trip is lossless (single-line fields). */
function singleLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

export function formatLearningContent(l: Learning): string {
  const anchorLine = l.anchors?.length
    ? `\nAnchors: ${l.anchors.map(singleLine).join(", ")}`
    : "";
  return `Kind: ${l.kind}\nTrigger: ${singleLine(l.trigger)}\nLesson: ${singleLine(l.lesson)}${anchorLine}`;
}

export function parseLearningContent(content: string): Partial<Learning> {
  const out: Partial<Learning> & { anchors?: string[] } = {};
  for (const line of content.split("\n")) {
    const m = /^(Kind|Trigger|Lesson|Anchors):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "Kind") out.kind = val as Learning["kind"];
    else if (key === "Trigger") out.trigger = val;
    else if (key === "Lesson") out.lesson = val;
    else if (key === "Anchors") out.anchors = val.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key + domain inference
// ---------------------------------------------------------------------------

function makeKey(l: Learning): string {
  const slug = (l.trigger || "learning")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const ts = Date.now().toString(36);
  return `learning/${l.kind}/${slug}-${ts}`;
}

/** Infer a domain tag from anchors + trigger text. Defaults to "general". */
export function inferDomain(l: Learning): string {
  const text = `${l.trigger} ${(l.anchors ?? []).join(" ")}`.toLowerCase();
  if (/\b(auth|token|login|session|jwt|cookie|password)\b/.test(text)) return "auth";
  if (/\b(ui|ux|css|component|view|page|react|vue|style|frontend)\b/.test(text)) return "frontend";
  if (/\b(api|route|handler|controller|service|endpoint|backend|server)\b/.test(text)) return "backend";
  if (/\b(ci|deploy|docker|k8s|infra|terraform|build|pipeline)\b/.test(text)) return "infra";
  if (/\b(test|spec|assert|fixture)\b/.test(text)) return "testing";
  return "general";
}
