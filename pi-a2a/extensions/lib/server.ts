/**
 * A2A inbound server — exposes Pi as an A2A-discoverable agent.
 *
 * Pi has no platform-adapter API (unlike Hermes' ctx.register_platform), so
 * inbound tasks each spawn an ISOLATED agent session via createAgentSession()
 * (the same proven path pi-subagent uses), run to completion, capture the
 * reply, and return it as the task result. This is "an agent invocation in
 * your repo", not "the live TUI session" — the correct, honest boundary for a
 * coding agent.
 *
 * Transport: node:http (stdlib). Security: localhost-default bind, token-gated
 * remote, outbound redaction, inbound injection filtering, audit log, anti-loop.
 *
 * Enabled only when `a2a.server.enabled` is true (default false).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PROTOCOL_VERSION,
  PI_SESSION_EXTENSION_URI,
  STATE_CANCELED,
  STATE_COMPLETED,
  STATE_FAILED,
  STATE_INPUT_REQUIRED,
  STATE_REJECTED,
  STATE_WORKING,
  buildAgentCard,
  buildTask,
  extractText,
  jsonrpcError,
  jsonrpcResult,
  newContextId,
  newTaskId,
  normalizeRole,
  type AgentCard,
  type Message,
  type Task,
} from "./protocol";
import type { A2AConfig } from "./config";
import { setGatewayPeers, setGatewayRegistrationName } from "./config";
import {
  AntiLoop,
  audit,
  authenticate,
  isTrustedPeer,
  localhostOnly,
  maxPingpongTurns,
  resolveBindHost,
  wrapInbound,
} from "./security";
import { metrics } from "./client";
import { heartbeat, register, unregister, type SessionDescriptor } from "./registry";
import { startBroadcast, startDiscovery, txtRecord, mdnsPeerKey, type MdnsHandle, type MdnsPeer } from "./mdns";
import type { InboundActivity } from "./activity";
import { preview } from "./activity";

// ---------------------------------------------------------------------------
// Task store (in-memory, bounded — evicts DONE tasks only, never running ones)
// ---------------------------------------------------------------------------

const MAX_TASKS = 500;

interface StoredTask {
  task: Task;
  controller?: AbortController;
  done: boolean;
  /** Set by tasks/cancel so the catch path classifies it as CANCELED, not timeout-FAILED. */
  userCanceled?: boolean;
  subscribeWatchers: Array<(t: Task) => void>;
}

class TaskStore {
  private tasks = new Map<string, StoredTask>();
  private order: string[] = [];

  get(id: string): StoredTask | undefined {
    return this.tasks.get(id);
  }

  add(id: string, st: StoredTask): void {
    this.tasks.set(id, st);
    this.order.push(id);
    // Evict oldest DONE tasks only. A running task (done=false) must never be
    // evicted or store.get(id)! would throw mid-execution. Guard against an
    // all-running pathological case with a hard cap.
    let guard = 0;
    while (this.order.length > MAX_TASKS && guard++ < MAX_TASKS * 2) {
      const old = this.order[0]!;
      const candidate = this.tasks.get(old);
      if (candidate && !candidate.done) {
        // Running — move to the back so it isn't re-examined every iteration.
        this.order.push(this.order.shift()!);
        continue;
      }
      this.order.shift();
      this.tasks.delete(old);
    }
  }

  list(): Task[] {
    return this.order.map((id) => this.tasks.get(id)?.task).filter((t): t is Task => !!t);
  }

  update(id: string, patch: (t: Task) => void): StoredTask | undefined {
    const st = this.tasks.get(id);
    if (!st) return undefined;
    patch(st.task);
    st.task.status.timestamp = new Date().toISOString();
    for (const w of st.subscribeWatchers) {
      try {
        w(st.task);
      } catch {
        /* watcher best-effort */
      }
    }
    return st;
  }
}

// ---------------------------------------------------------------------------
// Rate limiter (sliding window per identity; prunes stale entries)
// ---------------------------------------------------------------------------

class RateLimiter {
  private hits = new Map<string, number[]>();
  private sweepCounter = 0;
  private readonly sweepEvery = 64; // periodic prune of stale keys
  private readonly maxKeys = 10000;
  constructor(private perMin: number) {}

  check(identity: string): boolean {
    const now = Date.now();
    const win = (this.hits.get(identity) ?? []).filter((t) => now - t < 60000);
    if (win.length === 0) {
      this.hits.delete(identity);
    } else {
      this.hits.set(identity, win);
    }
    // Periodic sweep of stale entries so one-off identities don't accumulate.
    if (++this.sweepCounter >= this.sweepEvery) {
      this.sweepCounter = 0;
      for (const [k, v] of this.hits) {
        if (v.every((t) => now - t >= 60000)) this.hits.delete(k);
      }
    }
    // Hard cap to bound memory under adversarial unique-identity flooding.
    if (this.hits.size > this.maxKeys) {
      const firstKey = this.hits.keys().next().value;
      if (firstKey) this.hits.delete(firstKey);
    }
    if (win.length >= this.perMin) return false;
    win.push(now);
    this.hits.set(identity, win);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Session runner — the injectable boundary for testing
// ---------------------------------------------------------------------------

export interface SessionRunner {
  (opts: {
    message: string;
    signal: AbortSignal;
    onProgress?: (assistantTextDelta: string) => void;
  }): Promise<{ reply: string; inputRequired: boolean }>;
}

// ---------------------------------------------------------------------------
// A2A server
// ---------------------------------------------------------------------------

export class A2AServer {
  private http: Server | null = null;
  private boundPort: number | null = null;
  private store = new TaskStore();
  private antiLoop: AntiLoop;
  private limiter: RateLimiter;
  private cfg: A2AConfig;
  private ctx: ExtensionContext | undefined;
  private cwd: string;
  private piDir: string;
  private runner: SessionRunner | undefined;
  private running = 0; // concurrency counter (bounded by cfg.server.maxConcurrent)
  // Discovery state (0.2.0)
  private descriptor: SessionDescriptor | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private mdnsBroadcast: MdnsHandle | null = null;
  private mdnsDiscovery: MdnsHandle | null = null;
  private mdnsPeers: MdnsPeer[] = [];
  private gatewayUpstream: import("./gateway.js").GatewayUpstream | null = null;
  private pid = process.pid;
  private api: { getActiveTools?: () => string[] } | undefined;
  /** Host-TUI activity hook (0.3.0) — fired on task lifecycle events. */
  private onActivity: ((a: InboundActivity) => void) | undefined;
  /** Host-TUI status hook — gateway registration result (replaces console.log). */
  private onStatus: ((msg: string) => void) | undefined;
  /** Gateway diagnostic hook — upstream/channel failures (replaces console.error). */
  private onError: ((msg: string) => void) | undefined;

  constructor(opts: {
    cfg: A2AConfig;
    ctx?: ExtensionContext;
    cwd: string;
    piDir: string;
    runner?: SessionRunner;
    api?: { getActiveTools?: () => string[] };
    onActivity?: (a: InboundActivity) => void;
    /** Called with human-readable status lines (gateway registration) so the
     * host can surface them as a TUI toast instead of console.log. */
    onStatus?: (msg: string) => void;
    /** Gateway diagnostic lines (register failed, channel dropped, …) — kept
     * OFF the status surface so they never interleave with lifecycle lines. */
    onError?: (msg: string) => void;
  }) {
    this.cfg = opts.cfg;
    this.ctx = opts.ctx;
    this.api = opts.api;
    this.onActivity = opts.onActivity;
    this.onStatus = opts.onStatus;
    this.onError = opts.onError ?? console.error;
    this.cwd = opts.cwd;
    this.piDir = opts.piDir;
    this.runner = opts.runner;
    this.antiLoop = new AntiLoop(maxPingpongTurns(opts.cfg));
    this.limiter = new RateLimiter(opts.cfg.server.rateLimitPerMin);
  }

  setRunner(runner: SessionRunner): void {
    this.runner = runner;
  }

  /** Public URL the Agent Card advertises. Uses the ACTUAL bound port after
   * fallback (critical — advertising a configured-but-unbound port breaks
   * peers' callbacks). */
  private publicUrl(): string {
    const explicit = this.cfg.server.publicUrl.trim();
    if (explicit) return explicit.replace(/\/+$/, "") + "/";
    const host = resolveBindHost(this.cfg);
    const port = this.boundPort ?? this.cfg.server.port;
    return `http://${host}:${port}/`;
  }

  private buildCard(): AgentCard {
    const url = this.publicUrl();
    const name = this.cfg.server.agentName || hostname() || "pi";
    return buildAgentCard({
      name,
      url,
      description: "Pi coding agent — A2A-callable. Runs in the configured workspace.",
      skills: this.cfg.server.skills.length
        ? this.cfg.server.skills
        : [{ id: "coding", name: "coding", description: "Read, edit, run, debug, refactor, test" }],
      streaming: true,
      pushNotifications: false,
      authRequired: !localhostOnly(this.cfg),
      sessionMetadata: this.cfg.discovery.enrichCard && this.descriptor
        ? this.cardMetadata()
        : undefined,
    });
  }

  /** Build the A2A-Extensions metadata map from the live session descriptor. */
  private cardMetadata(): Record<string, unknown> {
    const d = this.descriptor!;
    return {
      pid: d.pid,
      cwd: d.cwd,
      model: d.model,
      tools: d.tools,
      sessionName: d.sessionName,
      selfIdentity: d.selfIdentity,
      agentName: d.agentName,
      startedAt: d.startedAt,
      // Extension URI echoed in metadata for peers that read metadata before capabilities.
      extension: PI_SESSION_EXTENSION_URI,
    };
  }

  /** Snapshot the current session identity (cwd/model/tools) into a descriptor. */
  /** Snapshot the current session identity (cwd/model/tools) into a descriptor. */
  private buildDescriptor(): SessionDescriptor {
    const m = this.ctx?.model as any;
    const model = m
      ? { provider: String(m.provider ?? ""), id: String(m.id ?? ""), name: m.name ? String(m.name) : undefined }
      : null;
    return {
      pid: this.pid,
      url: this.publicUrl(),
      port: this.boundPort ?? this.cfg.server.port,
      host: resolveBindHost(this.cfg),
      cwd: this.cwd,
      model,
      agentName: this.cfg.server.agentName || hostname() || "pi",
      sessionName: this.ctx ? (this.ctx as any).getSessionName?.() : undefined,
      selfIdentity: this.cfg.selfIdentity || undefined,
      tools: this.activeTools(),
      skills: this.cfg.server.skills.length
        ? this.cfg.server.skills
        : [{ id: "coding", name: "coding", description: "Read, edit, run, debug, refactor, test" }],
      startedAt: this.descriptor?.startedAt ?? new Date().toISOString(),
      mtime: Date.now(),
    };
  }

  /** Best-effort active-tools snapshot (ctx may not expose getActiveTools in all modes). */
  private activeTools(): string[] {
    try {
      if (this.api && typeof this.api.getActiveTools === "function") return this.api.getActiveTools();
    } catch {
      /* ignore */
    }
    return [];
  }

  /** Re-snapshot cwd/model/tools and refresh the registry + card (call on model_select). */
  refreshDescriptor(): void {
    if (!this.descriptor || !this.cfg.discovery.local.enabled) return;
    this.descriptor = this.buildDescriptor();
    heartbeat(this.descriptor, this.piDir);
  }

  /** Read-only access to discovered mDNS peers (for a2a_peers). */
  get discoveredMdnsPeers(): MdnsPeer[] {
    return this.mdnsPeers;
  }

  /** Start local-registry declaration + optional mDNS broadcast/discovery. */
  private async startDiscovery(): Promise<void> {
    // Build the descriptor unconditionally — it's needed for both local and mDNS.
    this.descriptor = this.buildDescriptor();

    // Layer 1: local file registry (opt-out).
    if (this.cfg.discovery.local.enabled) {
      register(this.descriptor, this.piDir);
      const intervalMs = Math.max(1, this.cfg.discovery.local.heartbeatSec) * 1000;
      this.heartbeatTimer = setInterval(() => {
        if (this.descriptor) heartbeat(this.descriptor, this.piDir);
      }, intervalMs);
      this.heartbeatTimer.unref?.(); // don't keep the process alive on exit
    }

    // Layer 3: mDNS broadcast + discovery (independent of local registry).
    if (this.cfg.discovery.mdns.enabled && this.descriptor) {
      const model = this.descriptor.model
        ? `${this.descriptor.model.provider}/${this.descriptor.model.id}`
        : "";
      this.mdnsBroadcast = await startBroadcast({
        serviceType: this.cfg.discovery.mdns.serviceType,
        name: this.descriptor.agentName,
        port: this.descriptor.port,
        txt: txtRecord({ url: this.descriptor.url, cwd: this.descriptor.cwd, model }),
      });
      this.mdnsDiscovery = await startDiscovery({
        serviceType: this.cfg.discovery.mdns.serviceType,
        onUp: (peer) => {
          // Dedupe by URL (or name:host:port composite); keep the freshest.
          const key = mdnsPeerKey(peer);
          const i = this.mdnsPeers.findIndex((p) => mdnsPeerKey(p) === key);
          if (i >= 0) this.mdnsPeers[i] = peer;
          else this.mdnsPeers.push(peer);
        },
        onDown: (gone) => {
          // Remove the departed peer so the list doesn't grow unbounded.
          this.mdnsPeers = this.mdnsPeers.filter(
            (p) => !(p.name === gone.name && p.host === gone.host && p.port === gone.port),
          );
        },
      });
    }
  }

  /** Register this session to the upstream agent-gateway (discovery.gateway config). */
  private async startGatewayUpstream(): Promise<void> {
    const gw = this.cfg.discovery.gateway;
    if (!gw || gw.enabled === false) return;
    const { GatewayUpstream } = await import("./gateway.js");
    // Unique name per session (name-port) unless explicitly pinned — sessions
    // on the same machine share config, and one gateway entry per live session
    // beats last-registration-wins.
    const base = gw.name || this.cfg.server.agentName || hostname() || "pi";
    const name = gw.name ? gw.name : `${base}-${this.boundPort}`;
    // Expose the resolved registration name to outbound callers (client.ts)
    // so X-Gateway-Caller matches the name registered on the gateway.
    // In-memory only — NEVER through setConfigOverrides, which loadConfig
    // applies and the /a2a-config panel would persist to settings.json.
    setGatewayRegistrationName(name);
    this.gatewayUpstream = new GatewayUpstream(
      {
        ...gw,
        name,
        // The gateway directory copies capabilities/skills from the registered
        // card — send the real Agent Card, not the local-registry descriptor.
        callTimeoutMs: this.cfg.timeouts.send,
        // Exact-match self-filter for the default auto-name — passed even
        // when the user pinned a name, so a stale auto-named entry from a
        // previous run is still filtered.
        autoName: `${base}-${this.boundPort}`,
      } as import("./gateway.js").GatewayConfig,
      () => this.buildCard() as unknown as Record<string, unknown>,
      this.onError,
      // Peer-directory overlay: refreshed after each heartbeat, cleared on stop.
      setGatewayPeers,
      // Lifecycle status (channel open, …) → host transcript like the
      // registration message, not raw console output.
      (msg) => {
        if (this.onStatus) {
          try {
            this.onStatus(msg);
          } catch {
            console.error(msg);
          }
        } else {
          console.error(msg);
        }
      },
    );
    const ok = await this.gatewayUpstream.start(this.publicUrl());
    if (ok) {
      const state = this.gatewayUpstream.lastState;
      const pending = state === "pending";
      const msg =
        `[a2a] registered to agent-gateway at ${gw.url} as ${name}` +
        (pending ? " (pending admin acceptance — not yet listed for peers)" : "");
      if (this.onStatus) {
        try {
          this.onStatus(msg);
          return;
        } catch {
          /* fall back to console */
        }
      }
      console.log(msg);
    }
  }

  private async stopGatewayUpstream(): Promise<void> {
    if (!this.gatewayUpstream) return;
    await this.gatewayUpstream.stop();
    this.gatewayUpstream = null;
    // The resolved registration name is session-scoped — stop presenting it
    // (and never persist it) once the upstream is gone.
    setGatewayRegistrationName(null);
  }

  /** Stop local-registry declaration + mDNS. */
  private async stopDiscovery(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.cfg.discovery.local.enabled) {
      unregister(this.pid, this.piDir);
    }
    if (this.mdnsBroadcast) {
      await this.mdnsBroadcast.stop();
      this.mdnsBroadcast = null;
    }
    if (this.mdnsDiscovery) {
      await this.mdnsDiscovery.stop();
      this.mdnsDiscovery = null;
    }
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.http) {
      return { host: resolveBindHost(this.cfg), port: this.boundPort ?? this.cfg.server.port, url: this.publicUrl() };
    }
    const host = resolveBindHost(this.cfg);
    const configuredPort = this.cfg.server.port;
    const fallback = Math.max(0, this.cfg.server.portFallback);

    // Try the configured port, then climb (port+1 … port+fallback), then fall
    // back to OS-assigned (0). Mirrors vite/webpack-dev-server "port busy → next".
    const attempts: number[] = [];
    if (configuredPort > 0) {
      for (let i = 0; i <= fallback; i++) attempts.push(configuredPort + i);
    }
    attempts.push(0); // last resort: OS assigns a free port

    let lastErr: unknown = null;
    for (const port of attempts) {
      const srv = createServer((req, res) => this.handle(req, res));
      try {
        await new Promise<void>((resolve, reject) => {
          srv.once("error", reject);
          srv.listen(port, host, () => {
            srv.removeListener("error", reject);
            resolve();
          });
        });
        this.http = srv;
        this.boundPort = (srv.address() as { port: number })?.port ?? port;
        await this.startDiscovery();
        await this.startGatewayUpstream();
        return { host, port: this.boundPort, url: this.publicUrl() };
      } catch (e: any) {
        lastErr = e;
        // EADDRINUSE → close this half-bound server and try the next port.
        try {
          srv.close();
        } catch {
          /* ignore */
        }
        if (e?.code !== "EADDRINUSE") {
          // Non-port error (permission, bad host, …) — don't keep climbing.
          throw e;
        }
        // Last attempt (port 0) failing with EADDRINUSE is impossible-ish, but
        // if the OS rejected everything, surface the last real error.
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("A2A server: no free port available");
  }

  async stop(): Promise<void> {
    if (!this.http) return;
    // Abort all running tasks so their runners stop promptly.
    for (const st of this.store.list()) {
      const s = this.store.get(st.id);
      if (s?.controller && !s.done) s.controller.abort();
    }
    // Stop accepting + force-close lingering connections (SSE streams, idle
    // keep-alive). closeAllConnections() lands the callback quickly instead of
    // hanging on open connections.
    await new Promise<void>((resolve) => {
      this.http!.close(() => resolve());
      try {
        this.http!.closeAllConnections();
      } catch {
        /* Node < 18.2 fallback — close() will drain normally */
      }
    });
    this.http = null;
    this.boundPort = null;
    await this.stopGatewayUpstream();
    await this.stopDiscovery();
  }

  get url(): string {
    // When stopped, don't advertise a configured-but-unbound port.
    if (!this.http) return "";
    return this.publicUrl();
  }

  /** The ACTUAL port this server bound (differs from cfg.server.port after
   * fallback). null when not started. */
  get port(): number | null {
    return this.boundPort;
  }

  /** For tests: how many tasks are currently running. */
  get runningCount(): number {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // HTTP handling
  // -------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = (req.url || "/").split("?")[0]!.replace(/\/+$/, "") || "/";
      if (req.method === "GET") return this.handleGet(url, req, res);
      if (req.method === "POST") return this.handlePost(req, res);
      return this.send(res, 405, { error: "method not allowed" });
    } catch (e: any) {
      return this.send(res, 500, { error: "internal", message: e?.message });
    }
  }

  private handleGet(url: string, _req: IncomingMessage, res: ServerResponse): void {
    if (url === "/.well-known/agent-card.json" || url === "/.well-known/agent.json") {
      return this.send(res, 200, this.buildCard());
    }
    if (url === "/health" || url === "/") {
      return this.send(res, 200, { status: "ok", agent: this.cfg.server.agentName || hostname() });
    }
    if (url === "/metrics") {
      return this.send(res, 200, metrics.snapshot());
    }
    return this.send(res, 404, { error: "not found" });
  }

  private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clientIp = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const identity = authenticate({
      authHeader: req.headers["authorization"],
      clientIp,
      peerTokens: this.cfg.server.peerTokens,
      sharedToken: this.cfg.server.sharedToken,
    });
    if (identity === null) {
      return this.send(res, 401, jsonrpcError(null, -32050, "unauthorized"));
    }
    if (!isTrustedPeer(identity, this.cfg)) {
      return this.send(res, 403, jsonrpcError(null, -32052, "untrusted peer"));
    }
    if (!this.limiter.check(identity)) {
      metrics.rateLimited += 1;
      return this.send(res, 429, jsonrpcError(null, -32051, "rate limited"));
    }

    const body = await this.readBody(req);
    let rpc: any;
    try {
      rpc = JSON.parse(body);
    } catch {
      return this.send(res, 200, jsonrpcError(null, -32700, "parse error"));
    }

    const method = String(rpc.method || "");
    const params = rpc.params || {};
    const id = rpc.id ?? null;

    // Normalize method aliases (v1.0 PascalCase ↔ pre-1.0 path).
    const norm = method.toLowerCase().replace(/[/_.-]/g, "");

    if (norm === "messagesend" || norm === "sendmessage") {
      // Concurrency cap: reject when too many tasks are already running.
      if (this.running >= this.cfg.server.maxConcurrent) {
        return this.send(
          res,
          503,
          jsonrpcError(id, -32053, `server busy: max ${this.cfg.server.maxConcurrent} concurrent tasks`),
        );
      }
      const r = await this.messageSend(params, identity);
      return this.send(res, 200, jsonrpcResult(id, r));
    }
    if (norm === "messagestream" || norm === "sendstreamingmessage") {
      return this.messageStream(params, identity, res, id);
    }
    if (norm === "tasksget" || norm === "gettask") {
      const t = this.store.get(String(params.id ?? ""))?.task;
      if (!t) return this.send(res, 200, jsonrpcError(id, -32001, "task not found"));
      return this.send(res, 200, jsonrpcResult(id, t));
    }
    if (norm === "taskslist" || norm === "listtasks") {
      const all = this.store.list().map((t) => ({ id: t.id, state: t.status.state }));
      return this.send(res, 200, jsonrpcResult(id, { tasks: all }));
    }
    if (norm === "taskscancel" || norm === "canceltask") {
      const st = this.store.get(String(params.id ?? ""));
      if (!st) return this.send(res, 200, jsonrpcError(id, -32001, "task not found"));
      if (st.done) return this.send(res, 200, jsonrpcError(id, -32002, "task not cancelable"));
      st.userCanceled = true; // so messageSend's catch classifies as CANCELED, not timeout-FAILED
      st.controller?.abort();
      // Set the state ourselves — the catch in messageSend will run async and
      // we must return CANCELED in THIS response, not the pre-abort WORKING.
      this.store.update(st.task.id, (t) => {
        t.status.state = STATE_CANCELED;
      });
      // NOTE: do NOT bump metrics here — messageSend's catch handles it once.
      return this.send(res, 200, jsonrpcResult(id, st.task));
    }
    if (norm === "taskssubscribe" || norm === "subscribetotask") {
      // Resubscribe via SSE — same shape as message/stream.
      return this.taskSubscribe(params, res, id);
    }
    return this.send(res, 200, jsonrpcError(id, -32601, `method not found: ${method}`));
  }

  private async messageSend(
    params: any,
    identity: string,
    externalSignal?: AbortSignal,
  ): Promise<any> {
    const msg: Message = params.message ?? params;
    const inboundText = extractText(params);
    const contextId = String(params.contextId || msg.contextId || newContextId());
    const taskId = newTaskId();

    // Anti-loop: cap per-context turns.
    if (!this.antiLoop.record(contextId)) {
      metrics.antiLoopTriggers += 1;
      const t = buildTask({ id: taskId, contextId, state: STATE_REJECTED });
      this.store.add(taskId, { task: t, done: true, subscribeWatchers: [] });
      audit({ piDir: this.piDir, direction: "inbound", identity, taskId, text: "[anti-loop rejected]" });
      return t;
    }

    // Create the task (SUBMITTED → WORKING).
    const task = buildTask({ id: taskId, contextId, state: STATE_WORKING });
    const controller = new AbortController();
    const st: StoredTask = { task, controller, done: false, subscribeWatchers: [] };
    this.store.add(taskId, st);
    audit({ piDir: this.piDir, direction: "inbound", identity, taskId, text: inboundText });
    this.onActivity?.({ type: "arrived", taskId, identity, text: inboundText, contextId });

    // If an external abort fires (client disconnect on streams, or tasks/cancel
    // on a streaming task), propagate it to the runner's controller.
    if (externalSignal) {
      const onExternal = () => controller.abort();
      externalSignal.addEventListener("abort", onExternal, { once: true });
      controller.signal.addEventListener("abort", () => externalSignal.removeEventListener("abort", onExternal), { once: true });
    }

    this.running += 1;
    const startedAt = Date.now();
    try {
      const timeoutMs = this.cfg.server.replyTimeoutSec * 1000;
      const timer = setTimeout(() => controller.abort(new Error("reply timeout")), timeoutMs);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      const wrapped = wrapInbound(identity, inboundText);
      const runner = this.requireRunner();
      const out = await runner({
        message: wrapped,
        signal: controller.signal,
        onProgress: (line) => this.onActivity?.({ type: "progress", taskId, line }),
      });
      clearTimeout(timer);
      const finalState = out.inputRequired ? STATE_INPUT_REQUIRED : STATE_COMPLETED;
      this.store.update(taskId, (t) => {
        t.status.state = finalState;
        t.artifacts = [
          {
            artifactId: "reply",
            name: "reply",
            parts: [{ text: out.reply, mediaType: "text/plain" }],
          },
        ];
      });
      st.done = true;
      metrics.tasksCompleted += 1;
      this.onActivity?.({
        type: "completed",
        taskId,
        state: finalState,
        replyPreview: preview(out.reply),
        elapsedMs: Date.now() - startedAt,
      });
      return st.task; // bare Task as the JSON-RPC result (legacy-compatible)
    } catch (e: any) {
      const aborted = controller.signal.aborted;
      // Distinguish user-initiated cancel (CANCELED) from system timeout/failure (FAILED).
      const state = aborted && st.userCanceled ? STATE_CANCELED : STATE_FAILED;
      this.store.update(taskId, (t) => {
        // Don't clobber a cancel-handler-set CANCELED state with an error message.
        t.status.state = state;
        if (state !== STATE_CANCELED) {
          t.status.message = {
            role: "ROLE_AGENT",
            parts: [{ text: e?.message || String(e), mediaType: "text/plain" }],
            messageId: newContextId(),
          };
        }
      });
      st.done = true;
      if (state === STATE_CANCELED) {
        // cancel doesn't count as a failure in completion metrics
        this.onActivity?.({
          type: "completed",
          taskId,
          state,
          replyPreview: "(canceled)",
          elapsedMs: Date.now() - startedAt,
        });
      } else {
        metrics.tasksFailed += 1;
        this.onActivity?.({
          type: "failed",
          taskId,
          error: e?.message || String(e),
          elapsedMs: Date.now() - startedAt,
        });
      }
      return st.task;
    } finally {
      this.running -= 1;
    }
  }

  private messageStream(params: any, identity: string, res: ServerResponse, id: any): void {
    // Concurrency cap: same gate as message/send. Streaming has already sent
    // 200 + headers, so we emit a JSON-RPC error frame and close the stream.
    if (this.running >= this.cfg.server.maxConcurrent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "A2A-Version": PROTOCOL_VERSION,
      });
      res.write(`data: ${JSON.stringify(jsonrpcError(id, -32053, `server busy: max ${this.cfg.server.maxConcurrent} concurrent tasks`))}\n\n`);
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "A2A-Version": PROTOCOL_VERSION,
    });
    // Each SSE data line is a JSON-RPC 2.0 response echoing the request id
    // (A2A v1.0 spec compliance — clients correlate streams by id).
    const writeSse = (result: any): void => {
      if (res.destroyed || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(jsonrpcResult(id, result))}\n\n`);
      } catch {
        /* res may be destroyed during shutdown */
      }
    };
    const writeErr = (code: number, message: string): void => {
      if (res.destroyed || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(jsonrpcError(id, code, message))}\n\n`);
      } catch {
        /* res may be destroyed during shutdown */
      }
    };

    // Abort the underlying task if the client disconnects mid-stream, so the
    // runner's session stops instead of burning tokens nobody will read.
    const disconnect = new AbortController();
    res.on("close", () => disconnect.abort());

    this.messageSend(params, identity, disconnect.signal)
      .then((task) => {
        writeSse({ statusUpdate: task });
        if (task.artifacts) {
          for (const a of task.artifacts) writeSse({ artifactUpdate: a });
        }
      })
      .catch((e: any) => writeErr(-32603, e?.message || String(e)))
      .finally(() => {
        metrics.streamsStarted += 1;
        try {
          res.end();
        } catch {
          /* ignore */
        }
      });
  }

  private taskSubscribe(params: any, res: ServerResponse, id: any): void {
    const taskId = String(params.id ?? "");
    const st = this.store.get(taskId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "A2A-Version": PROTOCOL_VERSION,
    });
    const writeSse = (result: any): void => {
      if (res.destroyed || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(jsonrpcResult(id, result))}\n\n`);
      } catch {
        /* res may be destroyed during shutdown */
      }
    };
    const writeErr = (code: number, message: string): void => {
      if (res.destroyed || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(jsonrpcError(id, code, message))}\n\n`);
      } catch {
        /* res may be destroyed during shutdown */
      }
    };
    if (!st) {
      writeErr(-32001, "task not found");
      res.end();
      return;
    }
    writeSse({ statusUpdate: st.task });
    if (st.done) {
      res.end();
      return;
    }
    const watcher = (t: Task): void => writeSse({ statusUpdate: t });
    st.subscribeWatchers.push(watcher);
    const interval = setInterval(() => {
      if (st.done) {
        clearInterval(interval);
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }, 500);
    res.on("close", () => {
      clearInterval(interval);
      st.subscribeWatchers = st.subscribeWatchers.filter((w) => w !== watcher);
    });
  }

  private requireRunner(): SessionRunner {
    if (!this.runner) {
      throw new Error(
        "no session runner configured — the inbound server needs a model/registry " +
          "from the host session to spawn agent sessions. Set a2a.server.enabled after " +
          "the session is ready, or configure a model.",
      );
    }
    return this.runner;
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX = 5 * 1024 * 1024; // 5MB cap
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX) {
          req.destroy();
          reject(new Error("payload too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private send(res: ServerResponse, status: number, body: any): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "A2A-Version": PROTOCOL_VERSION,
    });
    res.end(json);
  }
}
