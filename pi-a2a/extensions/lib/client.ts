/**
 * A2A outbound client — Pi as an A2A Client calling remote agents.
 *
 * Ported from Hermes tools.py. Uses global `fetch` (Node 18+); no deps.
 * Wire format: A2A v1.0 JSON-RPC `SendMessage`; v0.3 peers tolerated.
 *
 * Every call: redact → audit → persist → POST → unwrap → reply text.
 */

import {
  PROTOCOL_VERSION,
  STATE_INPUT_REQUIRED,
  extractText,
  newContextId,
  newTaskId,
  normalizeState,
  ROLE_USER,
  textMessage,
  unwrapSendMessageResponse,
  type AgentCard,
  type JsonRpcRequest,
} from "./protocol";
import {
  authHeaders,
  type A2AConfig,
  type Peer,
  resolvePeer,
} from "./config";
import {
  audit,
  redactOutbound,
} from "./security";
import {
  listConversations,
  loadConversation,
  persistMessage,
} from "./persistence";

// ---------------------------------------------------------------------------
// Card discovery
// ---------------------------------------------------------------------------

function cardUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/.well-known/agent-card.json";
}
function legacyCardUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/.well-known/agent.json";
}

/**
 * SSRF guard — block outbound requests to private/internal IP ranges unless
 * explicitly allowed. Prevents the model (or a prompt-injected instruction)
 * from exfiltrating data via cloud metadata endpoints (169.254.169.254) or
 * probing internal services. Loopback is allowed by default (local A2A peers
 * like Hermes on the same host are common).
 */
export function isPrivateHost(hostname: string): boolean {
  const raw = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const h = raw;
  // IPv4 literals: private ranges (RFC 1918), link-local (169.254), CGNAT
  // (100.64/10), and "this-network" (0/8). Loopback (127) is allowed for local peers.
  if (
    /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/.test(
      h,
    )
  ) {
    return true;
  }
  // IPv4-mapped IPv6 — Node canonicalizes to HEX form (::ffff:a9fe:a9fe),
  // but peers may also send dotted-decimal (::ffff:169.254.169.254).
  // Handle both by extracting the v4 octets and re-testing.
  const v4mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (v4mappedDotted) return isPrivateHost(v4mappedDotted[1]!);
  const v4mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (v4mappedHex) {
    const a = parseInt(v4mappedHex[1]!, 16);
    const b = parseInt(v4mappedHex[2]!, 16);
    // Reconstruct dotted-decimal: a = octet1.octet2, b = octet3.octet4
    const dotted = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
    return isPrivateHost(dotted);
  }
  // IPv6 link-local (fe80::/10), ULA (fc00::/7), unspecified (::), loopback
  // beyond ::1, multicast (ff00::/8).
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // ULA fc00::/7
  if (/^::1?$/.test(h)) return false; // ::1 loopback allowed
  if (h === "::") return true; // unspecified
  if (/^ff[0-9a-f]{2}:/.test(h)) return true; // multicast
  return false;
}

function assertSafeUrl(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${u.protocol} (only http/https)`);
  }
  // Block cloud-metadata and other private ranges (loopback excepted).
  if (isPrivateHost(u.hostname)) {
    throw new Error(`refused SSRF: ${u.hostname} is a private/internal host`);
  }
}

export async function fetchCard(
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<AgentCard | null> {
  assertSafeUrl(baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let resp = await fetch(cardUrl(baseUrl), { headers, signal: ctrl.signal });
    if (resp.status === 404) {
      resp = await fetch(legacyCardUrl(baseUrl), { headers, signal: ctrl.signal });
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as AgentCard;
  } finally {
    clearTimeout(timer);
  }
}

/** Pick the JSON-RPC dispatch URL: prefer the card's JSONRPC interface (v1.0
 * supportedInterfaces), then the card's top-level url, then the base. */
export function rpcUrl(baseUrl: string, card: AgentCard | null): string {
  if (card) {
    const iface = (card.supportedInterfaces ?? []).find(
      (i: any) => i?.protocolBinding === "JSONRPC" && i?.url,
    );
    if (iface?.url) return String(iface.url);
    if (typeof card.url === "string" && card.url) return card.url;
  }
  return baseUrl.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// HTTP POST (JSON-RPC)
// ---------------------------------------------------------------------------

async function postJsonRpc(
  url: string,
  body: JsonRpcRequest,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<any> {
  assertSafeUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "A2A-Version": PROTOCOL_VERSION,
        ...headers,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      // Don't leak internal service response bodies into model-facing errors.
      throw new Error(`peer returned non-JSON (HTTP ${resp.status})`);
    }
    if (!resp.ok && !json.error) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Reply extraction
// ---------------------------------------------------------------------------

function replyTextFromResult(result: any): string {
  const payload = unwrapSendMessageResponse(result);
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  // Artifacts first (final output), then status message, then bare message.
  const artifacts = payload.artifacts;
  if (Array.isArray(artifacts)) {
    for (const a of artifacts) {
      const t = extractText(a);
      if (t) return t;
    }
  }
  const status = payload.status ?? {};
  if (status.message) {
    return extractText(status.message);
  }
  return extractText(payload);
}

function stateFromResult(result: any): string {
  const payload = unwrapSendMessageResponse(result);
  if (payload && typeof payload === "object") {
    return normalizeState(payload.status?.state);
  }
  return "";
}

function contextFromResult(result: any, fallback: string): string {
  const payload = unwrapSendMessageResponse(result);
  if (payload && typeof payload === "object" && payload.contextId) {
    return String(payload.contextId);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Metrics (module singleton — shared across calls in a session)
// ---------------------------------------------------------------------------

export class Metrics {
  outboundTotal = 0;
  inboundTotal = 0;
  tasksCompleted = 0;
  tasksFailed = 0;
  streamsStarted = 0;
  antiLoopTriggers = 0;
  rateLimited = 0;
  pushSent = 0;
  private latencies: number[] = [];

  recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 200) this.latencies.shift();
  }

  snapshot(): Record<string, number | string> {
    const avg =
      this.latencies.length > 0
        ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
        : 0;
    return {
      outbound_total: this.outboundTotal,
      inbound_total: this.inboundTotal,
      tasks_completed: this.tasksCompleted,
      tasks_failed: this.tasksFailed,
      streams_started: this.streamsStarted,
      push_sent: this.pushSent,
      anti_loop_triggers: this.antiLoopTriggers,
      rate_limited: this.rateLimited,
      avg_latency_ms: avg,
    };
  }

  reset(): void {
    this.outboundTotal = 0;
    this.inboundTotal = 0;
    this.tasksCompleted = 0;
    this.tasksFailed = 0;
    this.streamsStarted = 0;
    this.antiLoopTriggers = 0;
    this.rateLimited = 0;
    this.pushSent = 0;
    this.latencies = [];
  }
}

export const metrics = new Metrics();

// ---------------------------------------------------------------------------
// Core send path
// ---------------------------------------------------------------------------

export interface SendResult {
  reply: string;
  contextId: string;
  state: string;
}

async function sendTask(opts: {
  cfg: A2AConfig;
  piDir: string;
  peer: Peer;
  agentLabel: string;
  message: string;
  contextId?: string;
}): Promise<SendResult> {
  const { cfg, piDir, peer, agentLabel, message } = opts;
  const headers = authHeaders(peer);
  const timeout = peer.timeout || cfg.timeouts.send;

  // Best-effort card fetch (to learn the rpc URL); non-fatal on failure.
  let card: AgentCard | null = null;
  try {
    card = await fetchCard(peer.url, headers, Math.min(timeout, 30000));
  } catch {
    /* tolerate */
  }

  const ctx = opts.contextId || newContextId();
  const safe = redactOutbound(message);
  const rpcBody: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: newTaskId(),
    method: "SendMessage",
    params: {
      message: textMessage(ROLE_USER, safe, ctx),
    },
  };

  audit({ piDir, direction: "outbound", identity: agentLabel, taskId: String(rpcBody.id), text: safe });
  metrics.outboundTotal += 1;

  const started = Date.now();
  const resp = await postJsonRpc(rpcUrl(peer.url, card), rpcBody, headers, timeout);
  metrics.recordLatency(Date.now() - started);
  if (resp.error) {
    const msg = resp.error.message || JSON.stringify(resp.error);
    throw new Error(`peer '${agentLabel}' returned an error: ${msg}`);
  }
  const result = resp.result ?? {};
  const reply = replyTextFromResult(result);
  const replyCtx = contextFromResult(result, ctx);
  const state = stateFromResult(result);
  // Persist BOTH the user message and the agent reply under the SAME contextId
  // (replyCtx) so a2a_history returns the complete conversation, not half.
  persistMessage({ piDir, contextId: replyCtx, role: "user", text: safe, taskId: String(rpcBody.id), peer: agentLabel });
  persistMessage({ piDir, contextId: replyCtx, role: "agent", text: reply, taskId: String(rpcBody.id), peer: agentLabel });
  metrics.inboundTotal += 1;
  if (state === "TASK_STATE_COMPLETED") metrics.tasksCompleted += 1;
  if (state === "TASK_STATE_FAILED") metrics.tasksFailed += 1;
  return { reply, contextId: replyCtx, state };
}

// ---------------------------------------------------------------------------
// Tool handlers (return formatted text for the model)
// ---------------------------------------------------------------------------

function shortState(state: string): string {
  return state ? state.replace("TASK_STATE_", "").replace(/_/g, "-").toLowerCase() : "";
}

export async function a2aDiscover(opts: {
  cfg: A2AConfig;
  url: string;
}): Promise<string> {
  const url = (opts.url || "").trim();
  if (!url) return "Error: 'url' is required (e.g. http://localhost:9900).";
  let card: AgentCard | null;
  try {
    card = await fetchCard(url, {}, opts.cfg.timeouts.send);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/HTTP 404/.test(msg)) return `Error: discovery failed — no Agent Card at ${url}.`;
    return `Error: could not reach ${url} — ${msg}`;
  }
  if (!card) return `Error: discovery failed — no Agent Card at ${url}.`;
  const caps = (card as any).capabilities || {};
  const skills = card.skills || [];
  const auth = (card as any).security ? "yes" : "no";
  const ifaces = (card.supportedInterfaces ?? []) as any[];
  const proto =
    ifaces
      .filter((i) => i && typeof i === "object")
      .map((i) => `${i.protocolBinding ?? "?"} v${i.protocolVersion ?? "?"}`)
      .join(", ") || `v${(card as any).protocolVersion ?? "?"} (pre-1.0 card)`;
  const lines = [
    `Agent: ${card.name || "?"}`,
    `Description: ${(card as any).description ?? ""}`,
    `URL: ${rpcUrl(url, card)}`,
    `Protocol: ${proto}`,
    `Streaming: ${!!caps.streaming}  Push: ${!!caps.pushNotifications}  Auth required: ${auth}`,
    `Skills (${skills.length}):`,
  ];
  for (const s of skills.slice(0, 20)) {
    lines.push(`  - ${s.name || s.id}: ${s.description ?? ""}`);
  }
  return lines.join("\n");
}

export async function a2aCall(opts: {
  cfg: A2AConfig;
  piDir: string;
  agent: string;
  message: string;
  contextId?: string;
}): Promise<string> {
  const agent = (opts.agent || "").trim();
  const message = (opts.message || "").trim();
  if (!agent || !message) return "Error: both 'agent' and 'message' are required.";
  const peer = resolvePeer(opts.cfg, agent);
  if (!peer || !peer.url) {
    return (
      `Error: unknown agent '${agent}'. Configure it under 'a2a.peers' in ` +
      `settings.json or pass a full http(s):// URL.`
    );
  }
  let result: SendResult;
  try {
    result = await sendTask({
      cfg: opts.cfg,
      piDir: opts.piDir,
      peer,
      agentLabel: agent,
      message,
      contextId: opts.contextId,
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/HTTP 401|HTTP 403/.test(msg)) return `Error: peer '${agent}' rejected auth. Check the configured token.`;
    if (/HTTP 429/.test(msg)) return `Error: peer '${agent}' rate limited us (HTTP 429). Retry later.`;
    return `Error: call to '${agent}' failed — ${msg}`;
  }
  let header = `[${agent} · context ${result.contextId}`;
  if (result.state) header += ` · ${shortState(result.state)}`;
  header += "]";
  let body = result.reply || "(no text reply)";
  if (result.state === STATE_INPUT_REQUIRED) {
    body +=
      `\n\n(The peer needs more input — answer by calling a2a_call again ` +
      `with context_id '${result.contextId}'.)`;
  }
  return `${header}\n${body}`;
}

export function a2aList(opts: { cfg: A2AConfig; piDir: string }): string {
  const { cfg, piDir } = opts;
  const peers = cfg.peers;
  const lines: string[] = [];
  const names = Object.keys(peers);
  if (names.length > 0) {
    lines.push(`Configured peers (${names.length}):`);
    for (const name of names) {
      const p = peers[name]!;
      const capStr = p.capabilities.length ? ` caps: ${p.capabilities.join(", ")}` : "";
      lines.push(`  - ${name}: ${p.url} (auth: ${p.auth.type})${capStr}`);
    }
  } else {
    lines.push("No peers configured. Add them under 'a2a.peers' in settings.json.");
  }
  const convos = listConversations(piDir);
  if (convos.length > 0) {
    lines.push("");
    lines.push(`Persisted conversations (${convos.length}) — recall with a2a_history:`);
    for (const c of convos.slice(0, 25)) lines.push(`  - ${c}`);
  }
  const m = metrics.snapshot();
  lines.push("");
  lines.push(
    `Metrics: ${m.outbound_total} out / ${m.inbound_total} in, ` +
      `${m.tasks_completed} completed, ${m.tasks_failed} failed, ` +
      `avg ${m.avg_latency_ms}ms`,
  );
  return lines.join("\n");
}

export function a2aHistory(opts: { piDir: string; contextId: string; limit?: number }): string {
  const ctx = (opts.contextId || "").trim();
  if (!ctx) return "Error: 'context_id' is required (see a2a_list for known conversations).";
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const msgs = loadConversation(opts.piDir, ctx, limit);
  if (msgs.length === 0) return `No persisted conversation for context '${ctx}'.`;
  const lines = [`Conversation ${ctx} (last ${msgs.length} messages):`];
  for (const m of msgs) {
    const role = m.role === "agent" ? "AGENT" : "USER";
    const t = (m.text || "").trim().slice(0, 1000);
    lines.push(`[${role}] ${t}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration: fan-out one task to every peer advertising a capability
// ---------------------------------------------------------------------------

function peerHasCapability(peer: Peer, capability: string): boolean {
  if (!peer.capabilities || peer.capabilities.length === 0) return false;
  const lc = capability.toLowerCase();
  return peer.capabilities.some((c) => c.toLowerCase() === lc);
}

const ORCHESTRATE_CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function a2aOrchestrate(opts: {
  cfg: A2AConfig;
  piDir: string;
  capability: string;
  message: string;
  mode?: "all" | "first" | "best";
}): Promise<string> {
  const mode = opts.mode || "all";
  const matching = Object.entries(opts.cfg.peers).filter(([, p]) => peerHasCapability(p!, opts.capability));
  if (matching.length === 0) {
    return `No configured peers advertise capability '${opts.capability}'.`;
  }
  const entries = matching.map(([name, peer]) => ({ name, peer: peer! }));

  const outcomes = await mapWithConcurrency(entries, ORCHESTRATE_CONCURRENCY, async ({ name, peer }) => {
    try {
      const r = await sendTask({
        cfg: opts.cfg,
        piDir: opts.piDir,
        peer,
        agentLabel: name,
        message: opts.message,
      });
      return { name, ok: true as const, reply: r.reply, ctx: r.contextId, state: r.state };
    } catch (e: any) {
      return { name, ok: false as const, error: e?.message || String(e) };
    }
  });

  const ok = outcomes.filter((o) => o.ok);
  const bad = outcomes.filter((o) => !o.ok);

  if (mode === "first") {
    const f = ok[0];
    if (f) return `[${f.name} · context ${f.ctx}]\n${f.reply || "(no reply)"}`;
  }
  if (mode === "best") {
    // Longest successful reply; errors never win. All-error → report failures.
    if (ok.length > 0) {
      const best = ok.slice().sort((a, b) => (b.reply?.length ?? 0) - (a.reply?.length ?? 0))[0]!;
      return `[${best.name} · context ${best.ctx}]\n${best.reply || "(no reply)"}`;
    }
  }
  // mode === "all" (or best with no successes)
  const lines: string[] = [];
  if (ok.length > 0) {
    lines.push(`Replies from ${ok.length}/${outcomes.length} peer(s) for '${opts.capability}':`);
    for (const o of ok) {
      lines.push(`\n── ${o.name} (context ${o.ctx}${o.state ? ` · ${shortState(o.state)}` : ""}) ──`);
      lines.push(o.reply || "(no reply)");
    }
  }
  if (bad.length > 0) {
    if (lines.length === 0) lines.push(`All ${bad.length} peer(s) failed for '${opts.capability}':`);
    else lines.push(`\nFailures (${bad.length}):`);
    for (const o of bad) lines.push(`  - ${o.name}: ${o.error}`);
  }
  return lines.join("\n");
}
