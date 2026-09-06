/**
 * pi-a2a — A2A Protocol v1.0 bidirectional extension for the Pi coding agent.
 *
 * OUTBOUND (always available): Pi discovers and delegates tasks to remote
 * A2A agents (Hermes, Google ADK, LangChain, CrewAI, any A2A peer).
 * INBOUND (opt-in via a2a.server.enabled): Pi exposes itself as an
 * A2A-discoverable agent other agents can call.
 *
 * Zero runtime deps — pure stdlib + global fetch. Follows the A2A v1.0 wire
 * format (JSON-RPC 2.0 over HTTP), tolerant of v0.3 peers. Security model
 * ported from Hermes: localhost-default bind, token-gated remote, outbound
 * redaction, inbound injection filtering, audit log, anti-loop.
 */

import { homedir } from "node:os";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { buildA2ASettingsPatch, getGatewayPeers, loadConfig, setConfigOverrides, writeSettingsA2A, type A2AConfig } from "./lib/config";
import {
  a2aCall,
  a2aDiscover,
  a2aHistory,
  a2aList,
  a2aOrchestrate,
  a2aStatus,
  metrics,
} from "./lib/client";
import { A2AServer, type SessionRunner } from "./lib/server";
import { formatPeers, listPeers } from "./lib/discovery";
import { childTranscriptDir } from "./lib/persistence";
import { activityLine, activityStatusLine, activityToText, classifyLine, dispatchLabel, preview, type InboundActivity } from "./lib/activity";
import { openPanel, type PanelAction } from "./lib/config-panel";

import { Container, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let server: A2AServer | null = null;

function piDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function cfgFor(ctx: ExtensionContext): A2AConfig {
  return loadConfig({ ctx, cwd: ctx.cwd ?? process.cwd() });
}

// ---------------------------------------------------------------------------
// Session runner — spawn an isolated Pi agent session per inbound task.
// (Same proven path pi-subagent uses; lazy import to avoid load cost.)
// ---------------------------------------------------------------------------

function makeSessionRunner(ctx: ExtensionContext, cfg?: A2AConfig): SessionRunner {
  return async ({ message, taskId, signal, onProgress }) => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader } = sdk;
    const modelRegistry = ctx.modelRegistry as any;
    const model = ctx.model;
    if (!model) throw new Error("no active model on the host session");
    const cwd = ctx.cwd || process.cwd();
    // Auto-compaction is the only recovery path a long dispatch has near
    // the context window: pi clamps max_tokens to the remaining budget
    // (down to 1 at the extreme), so without compact-and-retry the final
    // turn is cut and the task dies with a truncated or empty reply. The
    // keep window is scaled to the model's context window (stock: flat
    // 20k) because pi's cut-point walk never cuts at tool results — a
    // single tool-result batch bigger than the keep budget strands the
    // walk and auto-compaction silently no-ops exactly when it is most
    // needed. Dispatched coding tasks routinely produce such batches (one
    // large read or command dump), so the keep budget needs headroom
    // proportional to the window.
    const keepRecentTokens = Math.max(
      20_000,
      Math.floor((model.contextWindow ?? 128_000) / 5),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, keepRecentTokens },
      retry: { enabled: true, maxRetries: 1 },
    });
    // The loader must NOT receive the inMemory settingsManager: it would then
    // resolve zero extension packages and the child session would run without
    // any host extensions (pi-model-tools' ds-anchor bootstrap included).
    // Letting DefaultResourceLoader fall back to SettingsManager.create(cwd,
    // agentDir) loads the real on-disk settings/packages — the same path
    // pi-subagent's runner uses.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: sdk.getAgentDir(),
    });
    await resourceLoader.reload({
      // Forward the host's trust decision so project-local (.pi/) extensions
      // load in child sessions when the user already trusted the project —
      // same behavior as pi-subagent's runner; never prompt (no UI).
      resolveProjectTrust: async () => (ctx as any).isProjectTrusted?.() ?? false,
    });
    // Persist the child's transcript (fleet task #252). Stock pi-a2a ran
    // children on SessionManager.inMemory, so a dispatched worker that
    // stalled or was killed mid-run left NO step history — the only evidence
    // was its final A2A reply (196d39be: a worker stopped mid-sentence at
    // 989s and the cause could not be determined). AgentSession appends every
    // entry (user message, assistant turns, tool calls and results) to its
    // SessionManager synchronously as it runs, so a REAL SessionManager
    // gives each dispatch a full pi session file at
    // <agentDir>/a2a_sessions/<timestamp>_<taskId>.jsonl — openable with pi's
    // own session tooling and complete up to the moment of death even on a
    // window kill (the file materializes on the child's first assistant
    // output; a child that dies before ANY model output leaves no transcript,
    // covered instead by the FAILED task + audit line). Keyed by the A2A
    // taskId so ledger rows, the audit log, and the transcript all join on
    // one key; the host session lineage is preserved via parentSession.
    // Privacy: the transcript carries everything the worker read — the file
    // is chmod 600 at turn end, and server.childTranscriptRetentionDays
    // bounds its lifetime (swept on server start); set
    // a2a.server.childTranscripts=false for stock in-memory behavior.
    // Best-effort by design: any persistence failure falls back to the
    // in-memory manager — forensics must never break the dispatch itself.
    let transcriptPath: string | undefined;
    let sessionManager: any;
    if (taskId && cfg?.server.childTranscripts !== false) {
      try {
        const hostSession = (ctx as any).sessionManager;
        const hostSessionFile = hostSession?.getSessionFile?.();
        sessionManager = SessionManager.create(cwd, childTranscriptDir(piDir()), {
          id: taskId,
          ...(hostSessionFile ? { parentSession: hostSessionFile } : {}),
        });
        // Attribution entry: plain custom entries persist in the session
        // file but never enter the child's LLM context. Ties the transcript
        // to the dispatch and the host session lineage.
        sessionManager.appendCustomEntry("a2a/dispatch", {
          taskId,
          hostSessionId: hostSession?.getSessionId?.(),
          hostSessionFile,
        });
        transcriptPath = sessionManager.getSessionFile();
      } catch {
        sessionManager = undefined; // fall back to stock in-memory
      }
    }
    if (!sessionManager) sessionManager = SessionManager.inMemory(cwd);
    const created = await createAgentSession({
      cwd,
      model,
      thinkingLevel: ctx.thinkingLevel ?? "medium",
      resourceLoader,
      sessionManager,
      settingsManager,
      ...(modelRegistry?.runtime ? { modelRuntime: modelRegistry.runtime } : {}),
      ...(modelRegistry?.authStorage
        ? { authStorage: modelRegistry.authStorage, modelRegistry }
        : {}),
    } as any);
    const session = created.session;
    // Fire the extension session lifecycle for the child. createAgentSession
    // loads extension packages but never emits session_start — the SDK's own
    // print/rpc modes emit it via bindExtensions() right after creation — so
    // without this the child runs every extension's factory but none of their
    // session_start handlers: extensions that register tools there (e.g.
    // pi-mcp-extension, which wires ALL of its MCP servers/tools on
    // session_start) are silently missing from dispatched sessions. mode
    // "print" with no uiContext keeps ctx.hasUI === false, matching how the
    // host-only session_start guard below classifies child sessions.
    try {
      await session.bindExtensions({ mode: "print" });
    } catch {
      // Best-effort: a child that fails to bind still runs base tools.
    }
    let reply = "";
    let inputRequired = false;
    // Stop reason of the LAST assistant message and whether it carried any
    // text — consumed by the stunted-reply check after the run completes.
    let terminalStopReason: string | undefined;
    let terminalHadText = false;
    // Cheap progress marker for post-mortems (#256): assistant turns + tool
    // executions observed before the run ended.
    let stepCount = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const unsub = session.subscribe((event: any) => {
      // Forward meaningful activity to the host TUI (0.3.0): tool calls and
      // assistant text deltas become one-line progress entries.
      const line = activityLine(event);
      if (line && onProgress) onProgress(line);
      if (event.type === "tool_execution_start") {
        stepCount += 1;
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        stepCount += 1;
        // Agent-session events carry the OpenAI-style message shape: the text
        // parts live under `content` (e.g. [{type:"text",text:"..."}]), not
        // `parts` — reading `parts` yields nothing and the reply comes back
        // "(no reply)" even though the model answered correctly.
        const content = event.message?.content ?? event.message?.parts ?? [];
        const text = content
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .join("");
        if (text) reply = text;
        terminalStopReason = event.message?.stopReason;
        terminalHadText = Boolean(text);
        if (/\[INPUT_REQUIRED\]/i.test(reply)) {
          inputRequired = true;
          reply = reply.replace(/\[INPUT_REQUIRED\]\s*/gi, "").trim();
        }
      }
    });
    const onAbort = () => {
      // Settle the race (see the prompt race below) so a prompt() that
      // outlives session.abort() cannot hang the runner past the server's
      // reply window.
      resolveDone();
      try {
        session.abort();
      } catch {
        /* ignore */
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Whether the turn finished on its own before any abort fired, captured
    // the instant the race settles: an abort landing during the cleanup below
    // (the server clears its reply-window timer only after this runner
    // returns) must not retroactively fail a turn that already completed.
    let completedCleanly = false;
    try {
      // Settle the race on prompt() completion, not on agent_end: agent_end
      // fires when the model turn ends — BEFORE the post-run overflow
      // recovery that prompt() awaits (agent-session's _handlePostAgentRun
      // → compact-and-retry). Settling at agent_end let the cleanup below
      // dispose() the session while that recovery compaction was still in
      // flight (dispose → abortCompaction), so a context-clamped turn could
      // never recover even though pi's compact-and-retry would have saved
      // it. prompt() resolves only after recovery and any continuation
      // turns finish; aborts still settle the race immediately via onAbort
      // above.
      await Promise.race([session.prompt(message), done]);
      completedCleanly = !signal.aborted;
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsub();
      // dispose() does NOT emit session_shutdown (it only invalidates the
      // extension runner), so emit it explicitly first: extensions that
      // started processes on session_start (pi-mcp-extension's stdio MCP
      // servers) stop them on session_shutdown and would otherwise leak one
      // process per inbound task.
      try {
        await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      } catch {
        /* best-effort */
      }
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
      // The session file materializes lazily (SessionManager buffers
      // entries until the first assistant message), so tighten permissions
      // here — best-effort 0600 for a file that carries everything the
      // worker read.
      if (transcriptPath) {
        try {
          chmodSync(transcriptPath, 0o600);
        } catch {
          /* file never materialized (no model output) — nothing to chmod */
        }
      }
    }
    if (!completedCleanly) {
      // The reply window expired (or the caller canceled) mid-run: the race
      // ended because of the abort, not because the turn finished, so `reply`
      // holds at most a truncated partial answer. Throw so messageSend maps
      // the task to FAILED/CANCELED — returning normally takes the success
      // path and hands the dispatcher a truncated reply labelled COMPLETED,
      // indistinguishable from a finished worker (#247). Carry the transcript
      // forensics on the error so the failure audit line points at the step
      // history (#252).
      const err =
        signal.reason instanceof Error
          ? signal.reason
          : new Error("inbound session aborted before completing");
      try {
        if (transcriptPath) (err as any).transcriptPath = transcriptPath;
        (err as any).stepCount = stepCount;
      } catch {
        /* best-effort */
      }
      throw err;
    }

    if (terminalStopReason === "length" && !terminalHadText) {
      // A length stop with no assistant text means the provider capped
      // output before any usable content — typically max_tokens clamped
      // against the context estimate. `reply` still holds the PREVIOUS
      // turn's text, so returning normally would report the task COMPLETED
      // with a stale mid-work answer. Throw so the task maps to FAILED —
      // a dispatcher must not mistake this for a finished worker.
      throw new Error(
        "run ended on a length stop with no assistant text — no usable reply was produced (output capped before any content; context-clamped max_tokens?)",
      );
    }
    return {
      reply: reply || "(no reply)",
      inputRequired,
      ...(transcriptPath ? { transcriptPath } : {}),
      stepCount,
    };
  };
}

// ---------------------------------------------------------------------------
// Inbound activity → host TUI (0.3.0)
// ---------------------------------------------------------------------------

/** In-flight inbound tasks (identity + taskId), for the footer status line. */
const activeInboundTasks = new Map<string, { identity: string; last: InboundActivity }>();

/**
 * Surface an inbound activity event to the host TUI.
 * - transcript on: sendMessage (custom message, visible in transcript)
 * - always: notify() toast on arrived/completed/failed
 * Caller provides the ctx for ui access (may be undefined in tests).
 */
function broadcastActivity(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  cfg: A2AConfig | undefined,
  a: InboundActivity,
): void {
  const transcript = cfg?.ui?.transcript ?? true;
  if (transcript) {
    try {
      pi.sendMessage({
        customType: "a2a-inbound",
        content: activityToText(a),
        display: true,
      });
    } catch {
      /* session may be mid-replace; ignore */
    }
  }
  if (!ctx) return;
  switch (a.type) {
    case "arrived":
      activeInboundTasks.set(a.taskId, { identity: a.identity, last: a });
      // Toast stays short (it would flood the TUI); the transcript carries full text.
      ctx.ui.notify(`A2A dispatch from ${a.identity}: ${preview(a.text, 160)}`, "info");
      break;
    case "progress":
      activeInboundTasks.set(a.taskId, { identity: activeInboundTasks.get(a.taskId)?.identity ?? "peer", last: a });
      break;
    case "completed":
    case "failed":
      activeInboundTasks.delete(a.taskId);
      ctx.ui.notify(
        a.type === "completed"
          ? `A2A dispatch ${dispatchLabel(a.taskId)} completed (${(a.elapsedMs / 1000).toFixed(1)}s)`
          : `A2A dispatch ${dispatchLabel(a.taskId)} failed: ${a.error}`,
        a.type === "completed" ? "info" : "error",
      );
      break;
  }
  // Footer status while tasks are active.
  const active = [...activeInboundTasks.values()].map((t) => ({ taskId: t.last.taskId, identity: t.identity }));
  const status = activityStatusLine(active);
  try {
    ctx.ui.setStatus("a2a-inbound", status);
  } catch {
    /* best-effort */
  }
}

/** Status lines (gateway registration, channel open, …) → transcript + toast,
 *  rendered like the [A2A inbound] activity lines instead of vanishing in the
 *  console. */
function statusSink(pi: ExtensionAPI, ctx: ExtensionContext | undefined): (m: string) => void {
  return (m) => {
    // DELIBERATELY not pi.sendMessage: custom messages are converted to USER
    // MESSAGES in the LLM context (buildSessionContext), so routing lifecycle
    // lines through it polluted every model request with "[a2a] registered…"
    // / "gateway channel open…" noise — enough to derail DeepSeek v4 Pro's
    // minimal-mode bootstrap (request #1 must be a clean user message).
    // TUI notification only: visible to the human, invisible to the model.
    // Headless modes (json/print, hasUI=false) fall back to stderr so the
    // lifecycle remains observable — same pattern as errorSink.
    const ui = ctx && ctx.hasUI ? ctx.ui : undefined;
    if (ui) {
      try {
        ui.notify(m, "info");
      } catch {
        /* best-effort */
      }
    } else {
      try {
        console.error(m);
      } catch {
        /* best-effort */
      }
    }
  };
}

/** Gateway diagnostic/error lines → error toast only — a SEPARATE surface
 *  from the [a2a] status lines above, so failures don't render interleaved
 *  with lifecycle output in the transcript. Headless falls back to stderr. */
function errorSink(ctx: ExtensionContext | undefined): (m: string) => void {
  return (m) => {
    const ui = ctx && ctx.hasUI ? ctx.ui : undefined;
    if (ui) {
      try {
        ui.notify(m, "error");
        return;
      } catch {
        /* fall through */
      }
    }
    console.error(m);
  };
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const agentParam = Type.String({
  description:
    "Configured peer name (from a2a.peers in settings.json) OR a full http(s):// URL of an A2A agent.",
});
const messageParam = Type.String({ description: "Task message to send to the agent." });
const contextIdParam = Type.Optional(
  Type.String({
    description:
      "Context id from a prior call — reuse for multi-turn conversations. Omit for a new conversation.",
  }),
);

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default function a2aExtension(pi: ExtensionAPI): void {
  // Compact transcript renderer for inbound activity messages (0.3.0 → 0.6.2 UX).
  // Class-colored so the three phases of an A2A exchange read at a glance:
  //   ⚑ warning  — received from a peer (like a user turn, different color)
  //   ⚙ dim      — isolated session executing tools to answer
  //   ✎ success  — reply being sent back
  //   ✓ success / ✗ error — completion markers
  pi.registerMessageRenderer?.("a2a-inbound", (message, _opts, theme) => {
    try {
      const fg = theme.fg.bind(theme);
      const raw = message.content;
      const content = typeof raw === "string"
        ? raw
        : (Array.isArray(raw) ? raw.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") : "");
      const kind = classifyLine(content);
      const icon =
        kind === "received" ? "⚑" :
        kind === "failed" ? "✗" :
        kind === "replying" || kind === "completed" ? "✓" : "⇄";
      const color =
        kind === "received" ? "warning" :
        kind === "failed" ? "error" :
        kind === "executing" ? "dim" : "success";
      const c = new Container();
      c.addChild(new Text(fg(color, `${icon} ${content}`), 0, 0));
      return c;
    } catch {
      return undefined; // pi-tui unavailable → fall back to default rendering
    }
  });

  // -------------------------------------------------------------------------
  // Tools (outbound client) — always registered
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "a2a_call",
    label: "A2A Call",
    description:
      "Call a remote A2A (Agent2Agent) agent with a task message and return its reply. " +
      "Use to delegate work to other agents (Hermes, ADK, LangChain, CrewAI, any A2A peer). " +
      "Pass context_id to continue a multi-turn conversation. Set async_dispatch true for " +
      "long-running work: the call returns an ack with a task id immediately and the peer " +
      "keeps working — poll it with a2a_status.",
    promptSnippet: "delegate a task to a remote A2A agent and get its reply",
    promptGuidelines: [
      "Use for cross-agent task distribution and specialist delegation.",
      "The agent param is a configured peer name OR a full URL.",
      "For jobs that may run long, set async_dispatch true — you get a task id back " +
      "immediately instead of holding the call open; check a2a_status for the result.",
    ],
    parameters: Type.Object({
      agent: agentParam,
      message: messageParam,
      context_id: contextIdParam,
      async_dispatch: Type.Optional(
        Type.Boolean({
          description:
            "Non-blocking dispatch (A2A v1.0 returnImmediately): return an ack with the task id " +
            "as soon as the peer accepts, instead of waiting for the work to finish. " +
            "The peer runs the task detached — poll a2a_status for the result.",
          default: false,
        }),
      ),
    }),
    execute: async (_id, args, _signal, _onUpdate, ctx) => {
      const cfg = cfgFor(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: await a2aCall({
              cfg,
              piDir: piDir(),
              agent: String(args.agent ?? ""),
              message: String(args.message ?? ""),
              contextId: args.context_id ? String(args.context_id) : undefined,
              asyncDispatch: args.async_dispatch === true,
              discoveredPeers: listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "", gatewayPeers: getGatewayPeers() }),
            }),
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "a2a_status",
    label: "A2A Status",
    description:
      "Check the status of a task previously dispatched to a remote A2A agent (by task id — " +
      "see the ack from an async_dispatch a2a_call). Returns the task state, and the reply " +
      "text once the task is completed/failed. Optionally wait (wait_seconds) and poll until " +
      "the task reaches a terminal state.",
    promptSnippet: "poll the status of a task dispatched to a remote A2A agent",
    promptGuidelines: [
      "Use after an async_dispatch a2a_call to fetch the result of a long-running task.",
      "Without wait_seconds it fetches once; with it, the tool polls until the task is " +
      "terminal or the deadline passes (the task keeps running on the peer either way).",
    ],
    parameters: Type.Object({
      agent: agentParam,
      task_id: Type.String({
        description: "Task id from the dispatch ack (e.g. task-1b4f8d1c30d54819).",
      }),
      wait_seconds: Type.Optional(
        Type.Number({
          description: "If positive, poll until the task is terminal or this many seconds pass. " +
          "Omit (or 0/negative) for a single status fetch.",
        }),
      ),
    }),
    execute: async (_id, args, signal, _onUpdate, ctx) => {
      const cfg = cfgFor(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: await a2aStatus({
              cfg,
              piDir: piDir(),
              agent: String(args.agent ?? ""),
              taskId: String(args.task_id ?? ""),
              waitSeconds: typeof args.wait_seconds === "number" ? args.wait_seconds : undefined,
              discoveredPeers: listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "", gatewayPeers: getGatewayPeers() }),
              signal: signal ?? undefined,
            }),
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "a2a_discover",
    label: "A2A Discover",
    description:
      "Discover an A2A agent at a URL — fetches and summarizes its Agent Card (name, skills, capabilities, auth).",
    promptSnippet: "fetch a remote agent's Agent Card to learn its capabilities",
    parameters: Type.Object({
      url: Type.String({ description: "Base URL of the A2A agent (e.g. http://localhost:9900)." }),
    }),
    execute: async (_id, args, _signal, _onUpdate, ctx) => {
      const cfg = cfgFor(ctx);
      return {
        content: [
          { type: "text" as const, text: await a2aDiscover({ cfg, url: String(args.url ?? "") }) },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "a2a_list",
    label: "A2A List",
    description: "List configured A2A peers, persisted conversations, and call metrics.",
    promptSnippet: "show configured A2A peers and recent conversations",
    parameters: Type.Object({}),
    execute: async (_id, _args, _signal, _onUpdate, ctx) => {
      const cfg = cfgFor(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: a2aList({
              cfg,
              piDir: piDir(),
              discoveredPeers: listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "" }),
            }),
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "a2a_history",
    label: "A2A History",
    description: "Recall a persisted A2A conversation by context_id (survives compaction/restart).",
    promptSnippet: "reload a prior A2A conversation by context_id",
    parameters: Type.Object({
      context_id: Type.String({ description: "Context id of the conversation to recall." }),
      limit: Type.Optional(Type.Number({ description: "Max messages (default 50).", default: 50 })),
    }),
    execute: async (_id, args, _signal, _onUpdate, _ctx) => {
      return {
        content: [
          {
            type: "text" as const,
            text: a2aHistory({
              piDir: piDir(),
              contextId: String(args.context_id ?? ""),
              limit: typeof args.limit === "number" ? args.limit : undefined,
            }),
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "a2a_orchestrate",
    label: "A2A Orchestrate",
    description:
      "Fan a task out to every configured A2A peer advertising a capability, in parallel. " +
      "Modes: 'all' (default, every reply), 'first' (first success), 'best' (longest success).",
    promptSnippet: "delegate one task to multiple capable A2A peers in parallel",
    promptGuidelines: [
      "Peers advertise capabilities in a2a.peers.<name>.capabilities.",
      "Use 'first' for speed, 'best' for quality.",
    ],
    parameters: Type.Object({
      capability: Type.String({
        description: "Capability tag to match against peer capabilities (e.g. 'web_search', 'coding').",
      }),
      message: messageParam,
      mode: Type.Optional(
        Type.String({
          description:
            "Fan-out mode: 'all' (default, every reply), 'first' (first success), 'best' (longest success).",
          default: "all",
        }),
      ),
    }),
    execute: async (_id, args, _signal, _onUpdate, ctx) => {
      const cfg = cfgFor(ctx);
      return {
        content: [
          {
            type: "text" as const,
            text: await a2aOrchestrate({
              cfg,
              piDir: piDir(),
              capability: String(args.capability ?? ""),
              message: String(args.message ?? ""),
              mode: args.mode === "first" || args.mode === "best" ? args.mode : "all",
            }),
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "a2a_peers",
    label: "A2A Peers",
    description:
      "List discoverable A2A peers (local file registry, mDNS, and configured) with their " +
      "working folder, model, and tools. Use before a2a_call to pick the right peer for a task.",
    promptSnippet: "list discoverable A2A peers with their cwd/model/tools",
    promptGuidelines: [
      "Returns peers from three sources: local registry (same machine), mDNS (network), and configured (settings.json).",
      "Use it to choose which peer to delegate to based on working folder, model, or abilities.",
    ],
    parameters: Type.Object({}),
    execute: async (_id, _args, _signal, _onUpdate, ctx) => {
      const cfg = cfgFor(ctx);
      const peers = listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "", gatewayPeers: getGatewayPeers() });
      return { content: [{ type: "text" as const, text: formatPeers(peers) }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("a2a-discover", {
    description: "Discover an A2A agent at a URL: /a2a-discover <url>",
    handler: async (args, ctx) => {
      const url = String(args ?? "").trim();
      if (!url) {
        ctx.ui.notify("Usage: /a2a-discover <url>", "error");
        return;
      }
      const cfg = cfgFor(ctx as unknown as ExtensionContext);
      ctx.ui.notify(await a2aDiscover({ cfg, url }), "info");
    },
  });

  pi.registerCommand("a2a-agents", {
    description: "List configured A2A peers",
    handler: async (_args, ctx) => {
      const cfg = cfgFor(ctx as unknown as ExtensionContext);
      ctx.ui.notify(
        a2aList({
          cfg,
          piDir: piDir(),
          discoveredPeers: listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "" }),
        }),
        "info",
      );
    },
  });

  pi.registerCommand("a2a-send", {
    description: "Send a task to an A2A agent: /a2a-send <agent> <message>",
    getArgumentCompletions: (prefix) => {
      // Only the first token (peer name) is completable; the rest is free text.
      if (/\s/.test(prefix)) return null;
      const cfg = cfgFor(lastA2aCtx as unknown as ExtensionContext);
      const peers = listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "", gatewayPeers: getGatewayPeers() });
      const q = prefix.trim().toLowerCase();
      const items = peers
        .filter((p) => p.name.toLowerCase().startsWith(q))
        .map((p) => ({ value: p.name, label: p.name, description: p.url }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/);
      const agent = parts[0] ?? "";
      const message = parts.slice(1).join(" ");
      if (!agent || !message) {
        ctx.ui.notify("Usage: /a2a-send <agent> <message>", "error");
        return;
      }
      const cfg = cfgFor(ctx as unknown as ExtensionContext);
      const discoveredPeers = listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "", gatewayPeers: getGatewayPeers() });
      ctx.ui.notify(await a2aCall({ cfg, piDir: piDir(), agent, message, discoveredPeers }), "info");
    },
  });

  pi.registerCommand("a2a-broadcast", {
    description: "Broadcast a task to multiple agents: /a2a-broadcast <msg> --agents a,b,c",
    getArgumentCompletions: (prefix) => {
      // Offer the --agents flag while it isn't present yet.
      if (/--agents\b/.test(prefix)) return null;
      return [{ value: "--agents", label: "--agents", description: "comma-separated peer list" }];
    },
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const m = /--agents\s+(\S+)/.exec(raw);
      const message = raw.replace(/--agents\s+\S+/, "").trim();
      const agents = m?.[1]?.split(",") ?? [];
      if (!message || agents.length === 0) {
        ctx.ui.notify("Usage: /a2a-broadcast <msg> --agents a,b,c", "error");
        return;
      }
      const cfg = cfgFor(ctx as unknown as ExtensionContext);
      const discoveredPeers = listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "", gatewayPeers: getGatewayPeers() });
      const results = await Promise.all(
        agents.map((a) => a2aCall({ cfg, piDir: piDir(), agent: a, message, discoveredPeers })),
      );
      ctx.ui.notify(results.join("\n\n---\n\n"), "info");
    },
  });

  pi.registerCommand("a2a-status", {
    description: "Show A2A metrics and server status",
    handler: async (_args, ctx) => {
      const cfg = cfgFor(ctx as unknown as ExtensionContext);
      const m = metrics.snapshot();
      const lines = [
        `Name: ${server?.name ?? (cfg.server.agentName || "(default: <hostname>-<port> once started)")}`,
        `Server: ${server ? "running at " + server.url : cfg.server.enabled ? "enabled (not started)" : "disabled"}`,
        `Outbound: ${m.outbound_total} sent / ${m.inbound_total} replies`,
        `Dispatches: ${m.tasks_completed} completed, ${m.tasks_failed} failed`,
        `Avg latency: ${m.avg_latency_ms}ms`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("a2a-config", {
    description: "Configure A2A interactively (TUI) or show config",
    handler: async (args, ctx) => {
      const ectx = ctx as unknown as ExtensionContext;
      const cfg = cfgFor(ectx);
      const sub = String(args ?? "").trim().toLowerCase();

      // Non-interactive mode or explicit "show": print the summary.
      if (sub === "show" || ectx.mode !== "tui" || !ectx.hasUI) {
        ctx.ui.notify(
          [
            "Current A2A config:",
            `  server.enabled: ${cfg.server.enabled}`,
            `  server.port: ${cfg.server.port}`,
            `  server.host: ${cfg.server.host}`,
            `  discovery: local=${cfg.discovery.local.enabled} mdns=${cfg.discovery.mdns.enabled} enrichCard=${cfg.discovery.enrichCard}`,
            `  gateway: ${cfg.discovery.gateway ? `${cfg.discovery.gateway.enabled ? "enabled" : "disabled"} ${cfg.discovery.gateway.url || "(no url)"}${cfg.discovery.gateway.token ? " · token (set)" : ""}` : "not configured"}`,
            `  gateways: ${Object.keys(cfg.discovery.gateways ?? {}).join(", ") || "(none)"}`,
            `  ui.transcript: ${cfg.ui.transcript}`,
            `  peers: ${Object.keys(cfg.peers).join(", ") || "(none)"}`,
            "",
            "Interactive editor: run /a2a-config in TUI mode (no args).",
            "Or edit ~/.pi/agent/settings.json under the 'a2a' key.",
          ].join("\n"),
          "info",
        );
        return;
      }

      // TUI mode: open the interactive panel. Save persists to settings.json,
      // applies live via overrides, and restarts the server when needed.
      const workingCfg = structuredClone(cfg);
      let peerChanges = false;
      const beforePeers = JSON.stringify(workingCfg.peers);
      const beforeGateway = JSON.stringify(workingCfg.discovery.gateway ?? null);
      const beforeGateways = JSON.stringify(workingCfg.discovery.gateways ?? null);

      const actions: Record<string, PanelAction> = {
        addPeer: {
          label: "Add peer",
          run: (prompt) => {
            return new Promise<void>((resolve) => {
              prompt("Peer name", (name) => {
                if (!name) return resolve();
                prompt("Peer URL", (url) => {
                  if (!url) return resolve();
                  if (workingCfg.peers[name]) {
                    ctx.ui.notify(`Peer '${name}' already exists — edit its URL row instead.`, "warning");
                    return resolve();
                  }
                  workingCfg.peers[name] = {
                    url,
                    auth: { type: "none" },
                    timeout: 120000,
                    capabilities: [],
                  };
                  peerChanges = true;
                  resolve();
                });
              });
            });
          },
        },
        removePeer: {
          label: "Remove peer",
          run: (prompt) => {
            return new Promise<void>((resolve) => {
              const names = Object.keys(workingCfg.peers);
              if (names.length === 0) {
                ctx.ui.notify("No peers configured to remove.", "warning");
                return resolve();
              }
              prompt(`Remove peer (${names.join(", ")})`, (pick) => {
                if (!pick || !workingCfg.peers[pick]) return resolve();
                delete workingCfg.peers[pick];
                peerChanges = true;
                resolve();
              });
            });
          },
        },
        addGateway: {
          label: "Add gateway",
          run: (prompt) => {
            return new Promise<void>((resolve) => {
              prompt("Gateway key (e.g. work, lab — [A-Za-z0-9._-])", (key) => {
                if (!key) return resolve();
                if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
                  ctx.ui.notify("Invalid gateway key — use letters, digits, . _ -", "warning");
                  return resolve();
                }
                if (workingCfg.discovery.gateways?.[key]) {
                  ctx.ui.notify(`Gateway '${key}' already exists — edit its rows instead.`, "warning");
                  return resolve();
                }
                prompt(`Gateway URL for '${key}'`, (url) => {
                  if (!url) return resolve();
                  prompt(`API token for '${key}'`, (token) => {
                    workingCfg.discovery.gateways ??= {};
                    workingCfg.discovery.gateways[key] = {
                      enabled: true,
                      url: String(url),
                      token: String(token ?? ""),
                    };
                    resolve();
                  });
                });
              });
            });
          },
        },
        removeGateway: {
          label: "Remove gateway",
          run: (prompt) => {
            return new Promise<void>((resolve) => {
              const names = Object.keys(workingCfg.discovery.gateways ?? {});
              if (names.length === 0) {
                ctx.ui.notify("No gateways configured to remove.", "warning");
                return resolve();
              }
              prompt(`Remove gateway (${names.join(", ")})`, (pick) => {
                if (!pick || !workingCfg.discovery.gateways?.[pick]) return resolve();
                delete workingCfg.discovery.gateways[pick];
                resolve();
              });
            });
          },
        },
      };

      await openPanel(ectx, workingCfg, actions, (saved, editedKeys) => {
          if (!saved) return;
          const afterPeers = JSON.stringify(workingCfg.peers);
          const gatewayChanged =
            JSON.stringify(workingCfg.discovery.gateway ?? null) !== beforeGateway ||
            JSON.stringify(workingCfg.discovery.gateways ?? null) !== beforeGateways;
          const restartChanged =
            JSON.stringify(workingCfg.server) !== JSON.stringify(cfg.server) ||
            JSON.stringify(workingCfg.discovery) !== JSON.stringify(cfg.discovery);
          peerChanges = peerChanges || beforePeers !== afterPeers;

          // Persist to settings.json (a2a key, preserving other keys) via the
          // pure patch builder (unit-tested in config.test.ts). Key invariants:
          // a gateway block already in settings.json survives unrelated
          // discovery edits; env-sourced secrets are never copied to disk
          // unless the user edited that exact row.
          const written = writeSettingsA2A({
            cwd: ectx.cwd,
            patch: buildA2ASettingsPatch({
              cfg,
              working: workingCfg,
              peerChanges,
              gatewayChanged,
              editedGatewayKeys: editedKeys,
            }),
          });

          // Apply live for this session (no /reload needed).
          setConfigOverrides({
            peers: workingCfg.peers,
            selfIdentity: workingCfg.selfIdentity,
            server: workingCfg.server,
            discovery: workingCfg.discovery,
            ui: workingCfg.ui,
          });

          ctx.ui.notify(`A2A config saved → ${written}`, "info");

          // Restart the running server if server/discovery settings changed.
          if (restartChanged && server) {
            void (async () => {
              ctx.ui.notify("A2A config changed — restarting inbound server…", "info");
              try {
                await server!.stop();
              } catch {
                /* best-effort */
              }
              const fresh = cfgFor(ectx);
              server = new A2AServer({
                cfg: fresh,
                ctx: ectx,
                cwd: ectx.cwd,
                piDir: piDir(),
                runner: makeSessionRunner(ectx, fresh),
                api: pi,
                onActivity: (a) => broadcastActivity(pi, ectx, fresh, a),
                onStatus: statusSink(pi, ectx),
                onError: errorSink(ectx),
              });
              try {
                const info = await server.start();
                ctx.ui.notify(`A2A server restarted on ${info.host}:${info.port}`, "info");
              } catch (e: any) {
                server = null;
                ctx.ui.notify(`A2A server restart failed: ${e?.message || e}`, "error");
              }
            })();
          }
      });
    },
  });

  pi.registerCommand("a2a-server", {
    description: "Manage the inbound A2A server: /a2a-server start|stop|status",
    getArgumentCompletions: (prefix) => {
      const items = ["start", "stop", "status"]
        .filter((k) => k.startsWith(prefix.trim().toLowerCase()))
        .map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = String(args ?? "").trim().toLowerCase();
      const ectx = ctx as unknown as ExtensionContext;
      const cfg = cfgFor(ectx);
      if (sub === "start") {
        if (server) {
          ctx.ui.notify(`A2A server already running at ${server.url}`, "info");
          return;
        }
        try {
          server = new A2AServer({
            cfg,
            ctx: ectx,
            cwd: ectx.cwd,
            piDir: piDir(),
            runner: makeSessionRunner(ectx, cfg),
            api: pi,
            onActivity: (a) => broadcastActivity(pi, ectx, cfg, a),
            onStatus: statusSink(pi, ectx),
            onError: errorSink(ectx),
          });
          const info = await server.start();
          const defaultNote =
            cfg.server.port > 0 && info.port !== cfg.server.port
              ? ` (configured port ${cfg.server.port} was busy)`
              : "";
          ctx.ui.notify(
            `A2A server listening on ${info.host}:${info.port}${defaultNote} (Agent Card at ${info.url}.well-known/agent-card.json)`,
            "info",
          );
        } catch (e: any) {
          server = null;
          ctx.ui.notify(`Failed to start A2A server: ${e?.message || e}`, "error");
        }
        return;
      }
      if (sub === "stop") {
        if (!server) {
          ctx.ui.notify("A2A server is not running.", "info");
          return;
        }
        await server.stop();
        server = null;
        ctx.ui.notify("A2A server stopped.", "info");
        return;
      }
      ctx.ui.notify(
        server ? `A2A server running at ${server.url} (port ${server.port})` : "A2A server not running.",
        "info",
      );
    },
  });

  pi.registerCommand("a2a-peers", {
    description: "List discoverable A2A peers (local registry + mDNS + configured + gateway)",
    handler: async (_args, ctx) => {
      const cfg = cfgFor(ctx as unknown as ExtensionContext);
      const peers = listPeers({ cfg, piDir: piDir(), mdnsPeers: server?.discoveredMdnsPeers ?? [], selfUrl: server?.url ?? "", gatewayPeers: getGatewayPeers() });
      ctx.ui.notify(formatPeers(peers), "info");
    },
  });

  pi.registerCommand("a2a-help", {
    description: "Show A2A help",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          "A2A (Agent2Agent) Protocol v1.0 — commands:",
          "  /a2a-discover <url>          Fetch an agent's Agent Card",
          "  /a2a-agents                  List configured peers",
          "  /a2a-send <agent> <msg>      Send a task to a peer",
          "  /a2a-broadcast <msg> --agents a,b,c   Parallel fan-out",
          "  /a2a-status                  Metrics + server status",
          "  /a2a-config                  Interactive config panel (TUI)",
          "  /a2a-config show             Show config summary",
          "  /a2a-server start|stop|status  Manage inbound server",
          "",
          "Tools: a2a_call, a2a_status, a2a_discover, a2a_list, a2a_history, a2a_orchestrate",
        ].join("\n"),
        "info",
      );
    },
  });

  // -------------------------------------------------------------------------
  // Server lifecycle hooks (auto-start only when a2a.server.enabled)
  // -------------------------------------------------------------------------

  // Live model changes → refresh the session descriptor (registry file + card).
  pi.on("model_select", async () => {
    if (server) server.refreshDescriptor();
  });

  let lastA2aCtx: ExtensionContext | undefined;
  pi.on("session_start", async (_event, ctx) => {
    lastA2aCtx = ctx;
    // Only HOST sessions serve inbound A2A. SDK-created child sessions (a2a
    // inbound tasks via makeSessionRunner, pi-subagent children) have
    // hasUI=false AND mode='print' — without this guard every child would
    // auto-start its own A2AServer: same-pid registry overwrite, port climbing
    // per task, and duplicate gateway registration. The host session is the
    // single inbound server; children only run the task. json-mode hosts are
    // long-lived headless HOSTS (mode='json'), not children — they keep the
    // auto-start.
    if (!ctx.hasUI && ctx.mode !== "json") return;
    const cfg = cfgFor(ctx);
    if (!cfg.server.enabled) return;
    try {
      server = new A2AServer({
        cfg,
        ctx,
        cwd: ctx.cwd,
        piDir: piDir(),
        runner: makeSessionRunner(ctx, cfg),
        api: pi,
        onActivity: (a) => broadcastActivity(pi, ctx, cfg, a),
        onStatus: statusSink(pi, ctx),
        onError: errorSink(ctx),
      });
      const info = await server.start();
      const defaultNote =
        cfg.server.port > 0 && info.port !== cfg.server.port
          ? ` (configured port ${cfg.server.port} was busy)`
          : "";
      ctx.ui.notify(
        `A2A server listening on ${info.host}:${info.port}${defaultNote}. Agent Card: ${info.url}.well-known/agent-card.json`,
        "info",
      );
    } catch (e: any) {
      // Non-fatal: port fallback already handled EADDRINUSE; this only fires on
      // a genuine bind failure (permissions, invalid host, …). Outbound tools
      // keep working; only inbound serving is unavailable for this session.
      server = null;
      ctx.ui.notify(
        `A2A inbound server unavailable (${e?.message || e}). Outbound a2a_* tools still work.`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Only the HOST session owns the inbound server. Child sessions share
    // this cached extension factory (the loader caches it per process), so
    // the session_shutdown makeSessionRunner now emits for each child would
    // otherwise stop the host's shared `server` mid-dispatch. Same host-only
    // classification as session_start above: children have hasUI=false and
    // mode "print"; json-mode hosts are long-lived HOSTS, not children —
    // they keep the shutdown.
    if (!ctx.hasUI && ctx.mode !== "json") return;
    if (server) {
      try {
        await server.stop();
      } catch {
        /* best-effort */
      }
      server = null;
    }
  });
}
