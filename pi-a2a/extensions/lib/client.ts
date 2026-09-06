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
  TERMINAL_STATES,
  extractText,
  newContextId,
  newTaskId,
  normalizeState,
  ROLE_USER,
  textMessage,
  unwrapSendMessageResponse,
  type AgentCard,
  type JsonRpcRequest,
  type Task,
} from "./protocol";
import {
  authHeaders,
  gatewayEntries,
  getGatewayCallerName,
  getGatewayPeers,
  getGatewayRegistrationName,
  normUrl,
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
import { clean, type DiscoveredPeer } from "./discovery";
import { list as listRegistry } from "./registry";

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

/** Operator-configured gateway origins (all entries) — used to pin
 *  gateway-proxy peer URLs to a known gateway. */
function gatewayOrigins(cfg: A2AConfig): Set<string> {
  const out = new Set<string>();
  for (const { entry } of gatewayEntries(cfg)) {
    try {
      out.add(new URL(entry.url).origin);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** Gateway key from a `gw/<key>/<name>` peer label, or null. */
function gatewayKeyOfPeer(agentLabel: string): string | null {
  const m = /^gw\/([A-Za-z0-9._-]{1,64})\//.exec(agentLabel);
  return m ? m[1]! : null;
}

/** assertSafeUrl for gateway-proxy peers: the private-range block would reject
 *  LAN-hosted a2a-switchboard gateways (the primary self-hosted topology). Overlay URLs
 *  are same-origin-pinned to an operator-configured gateway URL by
 *  mergeGatewayPeers, so only those origins are permitted — never anything
 *  else. */
function assertGatewayUrl(rawUrl: string, origins: Set<string>): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${u.protocol} (only http/https)`);
  }
  if (!origins.has(u.origin)) {
    throw new Error(`refused SSRF: ${rawUrl} is outside the configured gateway origins`);
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
  gatewayOrigins?: Set<string>,
): Promise<any> {
  if (gatewayOrigins) assertGatewayUrl(url, gatewayOrigins);
  else assertSafeUrl(url);
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
  /** Set when the peer returned a Task (v1.0 wire) — the caller can poll it
   *  with GetTask (a2a_status). Always present for non-blocking dispatches. */
  taskId?: string;
}

/** Auth + asserted-identity headers for an outbound request to a peer.
 *  X-A2A-Identity (selfIdentity, falling back to server.agentName) names the
 *  caller for the RECEIVING side's audit log / attribution — behind a reverse
 *  proxy every caller arrives from the proxy's address, so address-based
 *  attribution cannot tell agents apart. Advisory display provenance only,
 *  never authentication: any client can assert any name, so a receiver must
 *  only use it to refine the display of a caller it has ALREADY admitted.
 *  Omitted when no identity is configured. Shared by EVERY outbound request
 *  (SendMessage dispatches AND the GetTask polls of a2a_status) so the
 *  receiver sees the same caller on dispatch and on every later poll. */
function peerRequestHeaders(cfg: A2AConfig, peer: Peer): Record<string, string> {
  const headers = authHeaders(peer);
  const self = cfg.selfIdentity || cfg.server.agentName;
  if (self) headers["X-A2A-Identity"] = self;
  return headers;
}

async function sendTask(opts: {
  cfg: A2AConfig;
  piDir: string;
  peer: Peer;
  agentLabel: string;
  message: string;
  contextId?: string;
  /** Non-blocking dispatch (A2A v1.0 §3.2.2 returnImmediately): the peer
   *  acks with an in-progress Task and runs the work detached from this
   *  call — the reply arrives later via GetTask (a2a_status). */
  asyncDispatch?: boolean;
}): Promise<SendResult> {
  const { cfg, piDir, peer, agentLabel, message } = opts;
  const headers = peerRequestHeaders(cfg, peer);
  // Advisory caller attribution for the gateway's routing log/dashboard.
  // Self-declared display name — stripped by the gateway before forwarding.
  if (peer.viaGateway) {
    // Prefer the operator-pinned identity; fall back to the runtime-resolved
    // registration name of the gateway this peer came from (set by the
    // server's upstream at start) or the base agent name so the dashboard
    // shows a real caller name, not a fingerprint. The registration name is
    // session-scoped and never persisted.
    const key = gatewayKeyOfPeer(agentLabel);
    // Manually-configured gateway peers (viaGateway without a `gw/<key>/`
    // label) fall back to the SINGLE configured gateway's registration name
    // (when exactly one gateway is configured) — otherwise there's no
    // unambiguous gateway to attribute to.
    let gwName: string | null = null;
    if (key) {
      gwName = getGatewayCallerName(key);
    } else {
      const entries = gatewayEntries(cfg);
      if (entries.length === 1) gwName = getGatewayCallerName(entries[0]!.key);
      else gwName = getGatewayRegistrationName();
    }
    const caller =
      cfg.selfIdentity || gwName || cfg.server.agentName || "";
    if (caller) headers["X-Gateway-Caller"] = caller;
  }
  const timeout = peer.timeout || cfg.timeouts.send;

  // Best-effort card fetch (to learn the rpc URL); non-fatal on failure.
  // Gateway peers are exempt: a proxied card advertises the peer's DIRECT
  // url, which would bypass the gateway — pin the RPC to the proxy URL.
  let card: AgentCard | null = null;
  if (!peer.viaGateway) {
    try {
      card = await fetchCard(peer.url, headers, Math.min(timeout, 30000));
    } catch {
      /* tolerate */
    }
  }

  const ctx = opts.contextId || newContextId();
  const safe = redactOutbound(message);
  const rpcBody: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: newTaskId(),
    method: "SendMessage",
    params: {
      message: textMessage(ROLE_USER, safe, ctx),
      ...(opts.asyncDispatch ? { configuration: { returnImmediately: true } } : {}),
    },
  };

  audit({ piDir, direction: "outbound", identity: agentLabel, taskId: String(rpcBody.id), text: safe });
  metrics.outboundTotal += 1;

  const started = Date.now();
  // SSRF pin: prefer the peer's own publishing gateway origin (overlay-first
  // routing works even when the live config has no gateway block); fall back
  // to the configured gateway origins; an empty set means the peer is not
  // gateway-pinned → normal assertSafeUrl applies.
  let gwOrigins: Set<string> | undefined;
  if (peer.viaGateway) {
    if (peer.gatewayUrl) {
      try {
        gwOrigins = new Set([new URL(peer.gatewayUrl).origin]);
      } catch {
        gwOrigins = undefined;
      }
    } else {
      const origins = gatewayOrigins(cfg);
      // Empty set = no gateway configured → normal assertSafeUrl applies.
      gwOrigins = origins.size > 0 ? origins : undefined;
    }
  }
  const resp = await postJsonRpc(rpcUrl(peer.url, card), rpcBody, headers, timeout, gwOrigins);
  metrics.recordLatency(Date.now() - started);
  if (resp.error) {
    const msg = resp.error.message || JSON.stringify(resp.error);
    throw new Error(`peer '${agentLabel}' returned an error: ${msg}`);
  }
  const result = resp.result ?? {};
  const payload = unwrapSendMessageResponse(result);
  const taskId = payload && typeof payload === "object" && payload.id ? String(payload.id) : undefined;
  const reply = replyTextFromResult(result);
  const replyCtx = contextFromResult(result, ctx);
  const state = stateFromResult(result);
  // Persist BOTH the user message and the agent reply under the SAME contextId
  // (replyCtx) so a2a_history returns the complete conversation, not half.
  // For a non-blocking dispatch the "reply" side is an ack marker — the real
  // reply arrives later via GetTask (a2a_status).
  const agentText =
    opts.asyncDispatch && taskId && !reply
      ? `(dispatched non-blocking — task ${taskId} is running on the peer; poll with a2a_status)`
      : reply;
  persistMessage({ piDir, contextId: replyCtx, role: "user", text: safe, taskId: String(rpcBody.id), peer: agentLabel });
  persistMessage({ piDir, contextId: replyCtx, role: "agent", text: agentText, taskId: String(rpcBody.id), peer: agentLabel });
  metrics.inboundTotal += 1;
  if (state === "TASK_STATE_COMPLETED") metrics.tasksCompleted += 1;
  if (state === "TASK_STATE_FAILED") metrics.tasksFailed += 1;
  return { reply, contextId: replyCtx, state, taskId };
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
  // Full session-metadata tool list from the pi-session extension (matches
  // the card's metadata.tools — never truncated).
  const meta = (card as any).metadata ?? {};
  const tools = Array.isArray(meta.tools) ? meta.tools.map(String) : [];
  if (tools.length) {
    lines.push(`Tools (${tools.length}):`);
    for (let i = 0; i < tools.length; i += 10) {
      lines.push(`  ${tools.slice(i, i + 10).join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** Resolve an agent label (configured name, URL, or discovered name) to a
 *  peer for an outbound call. Returns an error string instead of a peer when
 *  the label cannot be resolved. Shared by a2a_call and a2a_status. */
function resolveCallPeer(opts: {
  cfg: A2AConfig;
  piDir: string;
  agent: string;
  /** Live discovered peers (listPeers output) — lets local/mDNS peers be called by name. */
  discoveredPeers?: DiscoveredPeer[];
}): { peer: Peer } | { error: string } {
  const agent = opts.agent;
  const known = knownLoopbackUrls(opts.cfg, opts.piDir);
  let peer = resolvePeer(opts.cfg, agent, { knownLoopbackUrls: known });
  if (!peer || !peer.url) {
    // Discovered-peer name lookup (local registry / mDNS). Ambiguous names
    // error with the candidate URLs instead of guessing a target.
    const matches = (opts.discoveredPeers ?? []).filter((d) => d.name === agent && d.url);
    if (matches.length > 1) {
      return {
        error:
          `Error: ${matches.length} discovered peers share the name '${agent}' — ` +
          `call by URL: ${matches.map((m) => m.url).join(", ")}`,
      };
    }
    if (matches.length === 1) {
      // ponytail: re-resolve via the URL branch so loopback-token/SSRF policy is inherited verbatim
      peer = resolvePeer(opts.cfg, matches[0]!.url, { knownLoopbackUrls: known });
    }
  }
  if (!peer || !peer.url) {
    return {
      error:
        `Error: unknown agent '${agent}'. Configure it under 'a2a.peers' in ` +
        `settings.json, pass a full http(s):// URL, or use a name from a2a_peers.`,
    };
  }
  return { peer };
}

export async function a2aCall(opts: {
  cfg: A2AConfig;
  piDir: string;
  agent: string;
  message: string;
  contextId?: string;
  /** Live discovered peers (listPeers output) — lets local/mDNS peers be called by name. */
  discoveredPeers?: DiscoveredPeer[];
  /** Non-blocking dispatch (A2A v1.0 §3.2.2 returnImmediately): return an
   *  ack with the task id as soon as the peer accepts the task, instead of
   *  holding this call open until the work finishes. Long jobs keep running
   *  on the peer no matter how long the caller waits — poll a2a_status. */
  asyncDispatch?: boolean;
}): Promise<string> {
  const agent = (opts.agent || "").trim();
  const message = (opts.message || "").trim();
  if (!agent || !message) return "Error: both 'agent' and 'message' are required.";
  const resolved = resolveCallPeer({
    cfg: opts.cfg,
    piDir: opts.piDir,
    agent,
    discoveredPeers: opts.discoveredPeers,
  });
  if ("error" in resolved) return resolved.error;
  const peer = resolved.peer;
  let result: SendResult;
  try {
    result = await sendTask({
      cfg: opts.cfg,
      piDir: opts.piDir,
      peer,
      agentLabel: agent,
      message,
      contextId: opts.contextId,
      asyncDispatch: opts.asyncDispatch,
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/HTTP 401|HTTP 403/.test(msg)) return `Error: peer '${agent}' rejected auth. Check the configured token.`;
    if (/HTTP 429/.test(msg)) return `Error: peer '${agent}' rate limited us (HTTP 429). Retry later.`;
    return `Error: call to '${agent}' failed — ${msg}`;
  }
  // Non-blocking ack: the peer accepted the task and is running it detached
  // from this call. (A peer that does not support returnImmediately simply
  // blocks and returns a terminal task — fall through to normal formatting.)
  if (opts.asyncDispatch && result.taskId && !TERMINAL_STATES.has(result.state)) {
    return (
      `[A2A → ${agent} · context ${result.contextId} · ${shortState(result.state)} · detached]\n` +
      `Dispatch accepted — task ${result.taskId} is running on the peer (non-blocking). ` +
      `This call has already returned; the peer keeps working regardless of how long it takes. ` +
      `Poll the result with a2a_status(agent: "${agent}", task_id: "${result.taskId}").`
    );
  }
  let header = `[A2A → ${agent} · context ${result.contextId}`;
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

// ---------------------------------------------------------------------------
// Task status / polling (GetTask)
// ---------------------------------------------------------------------------

/** sleep that also resolves when `signal` aborts, so poll waits do not hold
 *  a canceled tool call open — a2a_status with wait_seconds=300 must stay
 *  interruptible. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    if (signal) {
      if (signal.aborted) return done();
      signal.addEventListener("abort", done, { once: true });
    }
  });
}

/** Fetch one task's current state from a peer via GetTask (A2A v1.0). The
 *  peer's per-identity task ownership applies: only the caller that created
 *  the task can read it. */
export async function getTask(opts: {
  cfg: A2AConfig;
  peer: Peer;
  taskId: string;
}): Promise<Task> {
  const headers = peerRequestHeaders(opts.cfg, opts.peer);
  const timeout = opts.peer.timeout || opts.cfg.timeouts.send;
  // Best-effort card fetch (to learn the rpc URL); non-fatal on failure.
  let card: AgentCard | null = null;
  try {
    card = await fetchCard(opts.peer.url, headers, Math.min(timeout, 30000));
  } catch {
    /* tolerate */
  }
  const rpcBody: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: newTaskId(),
    method: "GetTask",
    params: { id: opts.taskId },
  };
  const resp = await postJsonRpc(rpcUrl(opts.peer.url, card), rpcBody, headers, timeout);
  if (resp.error) {
    const err = new Error(`peer returned an error: ${resp.error.message || JSON.stringify(resp.error)}`);
    (err as any).code = resp.error.code;
    throw err;
  }
  return unwrapSendMessageResponse(resp.result ?? {}) as Task;
}

function formatTask(task: Task): string {
  const header = `[task ${task.id} · context ${task.contextId} · ${shortState(task.status?.state ?? "")}` +
    (task.status?.timestamp ? ` · ${task.status.timestamp}` : "") + "]";
  // Artifacts first (final output), then status message — same precedence as
  // replyTextFromResult.
  let body = "";
  if (Array.isArray(task.artifacts)) {
    for (const a of task.artifacts) {
      const t = extractText(a);
      if (t) { body = t; break; }
    }
  }
  if (!body && task.status?.message) body = extractText(task.status.message);
  if (!body) body = "(no text yet — task is in progress)";
  return `${header}\n${body}`;
}

export async function a2aStatus(opts: {
  cfg: A2AConfig;
  piDir: string;
  agent: string;
  taskId: string;
  /** When POSITIVE (seconds), poll until the task reaches a terminal state
   *  or the deadline — polls at cfg.timeouts.async intervals (the documented
   *  "async task poll interval"). 0, negative, or undefined = a single
   *  fetch. */
  waitSeconds?: number;
  discoveredPeers?: DiscoveredPeer[];
  /** Aborts the polling loop promptly (tool cancel): checked before each
   *  fetch, raced into the poll sleep, and re-checked after it — a canceled
   *  a2a_status with wait_seconds=300 must not hold the tool call open.
   *  Aborting does NOT affect the task on the peer; it keeps running. */
  signal?: AbortSignal;
}): Promise<string> {
  const agent = (opts.agent || "").trim();
  const taskId = (opts.taskId || "").trim();
  if (!agent || !taskId) return "Error: both 'agent' and 'task_id' are required.";
  const resolved = resolveCallPeer({
    cfg: opts.cfg,
    piDir: opts.piDir,
    agent,
    discoveredPeers: opts.discoveredPeers,
  });
  if ("error" in resolved) return resolved.error;
  const peer = resolved.peer;
  // Non-positive wait_seconds is treated as "unset" — a single fetch. A
  // negative value would otherwise poll once, immediately expire, and print
  // nonsense like "after -5s of polling".
  const waitSeconds = typeof opts.waitSeconds === "number" && opts.waitSeconds > 0 ? opts.waitSeconds : undefined;
  const deadline = waitSeconds !== undefined ? Date.now() + waitSeconds * 1000 : 0;
  const interval = Math.max(250, opts.cfg.timeouts.async);
  let lastTask: Task | null = null;
  for (;;) {
    if (opts.signal?.aborted) return statusCanceled(agent, taskId, lastTask);
    let task: Task;
    try {
      task = await getTask({ cfg: opts.cfg, peer, taskId });
    } catch (e: any) {
      if ((e as any).code === -32001) {
        return `Error: peer '${agent}' does not know task '${taskId}' (unknown id, already evicted, or created by a different caller — tasks are visible only to the identity that sent them).`;
      }
      const msg = e?.message || String(e);
      if (/HTTP 401|HTTP 403/.test(msg)) return `Error: peer '${agent}' rejected auth. Check the configured token.`;
      return `Error: status check for '${agent}' task '${taskId}' failed — ${msg}`;
    }
    lastTask = task;
    const state = normalizeState(task.status?.state);
    if (TERMINAL_STATES.has(state) || waitSeconds === undefined) {
      return formatTask(task);
    }
    if (Date.now() >= deadline) {
      return (
        formatTask(task) +
        `\n\n(Still non-terminal after ${waitSeconds}s of polling — the task keeps running on the peer; call a2a_status again later.)`
      );
    }
    await sleepAbortable(Math.min(interval, Math.max(0, deadline - Date.now())), opts.signal);
  }
}

/** a2a_status's abort message: report the last-known state (the task itself
 *  is untouched — aborting a poll never touches the peer's run) and how to
 *  pick the poll back up. */
function statusCanceled(agent: string, taskId: string, lastTask: Task | null): string {
  const body = lastTask ? formatTask(lastTask) : `task ${taskId}: status not yet fetched.`;
  return (
    body +
    `\n\n(Status polling canceled — the task keeps running on the peer regardless; call a2a_status(agent: "${agent}", task_id: "${taskId}") again later.)`
  );
}

/** Build the set of loopback URLs that are KNOWN peers (same-machine, same-user):
 *  configured peers + live local-registry entries. mDNS peers are excluded —
 *  their URLs come from the network and must not receive the shared token. */
function knownLoopbackUrls(cfg: A2AConfig, piDir: string): Set<string> {
  const known = new Set<string>();
  for (const p of Object.values(cfg.peers)) {
    if (p.url) known.add(normUrl(p.url));
  }
  try {
    for (const d of listRegistry({ piDir, ttlSec: cfg.discovery.local.ttlSec })) {
      if (d.url) known.add(normUrl(d.url));
    }
  } catch {
    /* registry read is best-effort */
  }
  return known;
}

export function a2aList(opts: {
  cfg: A2AConfig;
  piDir: string;
  /** Pre-merged discovered peers (local registry + mDNS). When provided, an
   * extra "Discovered peers" section is appended. */
  discoveredPeers?: Array<{
    name: string;
    url: string;
    source: string;
    cwd?: string;
    model?: { provider: string; id: string; name?: string } | null;
    tools?: string[];
  }>;
}): string {
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

  // Gateway overlay (read-only, in-memory — refreshed after each gateway
  // heartbeat; never written to settings.json).
  const gateway = Object.entries(getGatewayPeers());
  if (gateway.length > 0) {
    lines.push("");
    lines.push(`Gateway peers (${gateway.length}) — call by name, routed via the a2a-switchboard proxy:`);
    for (const [name, p] of gateway) {
      const capStr = p.capabilities.length ? ` caps: ${p.capabilities.join(", ")}` : "";
      lines.push(`  - ${name}: ${p.url} (auth: ${p.auth.type})${capStr}`);
    }
  }

  // Discovered peers (0.2.0) — exclude any already listed above (by URL):
  // configured peers AND gateway proxy entries (same underlying agent would
  // otherwise appear twice — once as gw/remote/x, once as a local discovery).

  const listedUrls = new Set([
    ...names.map((n) => peers[n]!.url.replace(/\/+$/, "").toLowerCase()),
    ...gateway.map(([, p]) => p.url.replace(/\/+$/, "").toLowerCase()),
  ]);
  const discovered = (opts.discoveredPeers ?? []).filter(
    (p) => !listedUrls.has(p.url.replace(/\/+$/, "").toLowerCase()),
  );
  if (discovered.length > 0) {
    lines.push("");
    lines.push(`Discovered peers (${discovered.length}):`);
    for (const p of discovered) {
      const parts = [`  - ${clean(p.name)}`, clean(p.url), `[${p.source}]`];
      if (p.cwd) parts.push(`cwd=${clean(p.cwd)}`);
      if (p.model) parts.push(`model=${clean(p.model.provider)}/${clean(p.model.id)}`);
      if (p.tools && p.tools.length) {
        const shown = p.tools.slice(0, 20).map(clean).join(",");
        parts.push(`tools=${shown}${p.tools.length > 20 ? ` (+${p.tools.length - 20} more)` : ""}`);
      }
      lines.push(parts.join("  "));
    }
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
  // Configured peers + gateway overlay (read-only). Dedupe: a configured peer
  // wins over its gateway alias — by URL or by the gateway key's underlying
  // name (`gw/<key>/<name>` → `<name>`) — same precedence as resolvePeer.
  const configuredUrls = new Set(Object.values(opts.cfg.peers).map((p) => normUrl(p!.url)));
  const configuredNames = new Set(Object.keys(opts.cfg.peers));
  const gwUnderlying = (k: string) => k.split("/").pop() ?? k;
  const pool: Array<[string, Peer]> = [
    ...Object.entries(getGatewayPeers()).filter(
      ([k, p]) => !configuredUrls.has(normUrl(p.url)) && !configuredNames.has(gwUnderlying(k)),
    ),
    ...Object.entries(opts.cfg.peers),
  ];
  const matching = pool.filter(([, p]) => peerHasCapability(p, opts.capability));
  if (matching.length === 0) {
    return `No peers advertise capability '${opts.capability}'.`;
  }
  const entries = matching.map(([name, peer]) => ({ name, peer }));

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
