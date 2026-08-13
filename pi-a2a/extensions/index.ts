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
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, resolvePeer, type A2AConfig } from "./lib/config";
import {
  a2aCall,
  a2aDiscover,
  a2aHistory,
  a2aList,
  a2aOrchestrate,
  metrics,
} from "./lib/client";
import { A2AServer, type SessionRunner } from "./lib/server";

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

function makeSessionRunner(ctx: ExtensionContext): SessionRunner {
  return async ({ message, signal }) => {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader } = sdk;
    const modelRegistry = ctx.modelRegistry as any;
    const model = ctx.model;
    if (!model) throw new Error("no active model on the host session");
    const cwd = ctx.cwd || process.cwd();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: sdk.getAgentDir(),
      settingsManager,
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      model,
      thinkingLevel: "medium",
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      ...(modelRegistry?.runtime ? { modelRuntime: modelRegistry.runtime } : {}),
      ...(modelRegistry?.authStorage
        ? { authStorage: modelRegistry.authStorage, modelRegistry }
        : {}),
    } as any);
    const session = created.session;
    let reply = "";
    let inputRequired = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const unsub = session.subscribe((event: any) => {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        // Agent-session events carry the OpenAI-style message shape: the text
        // parts live under `content` (e.g. [{type:"text",text:"..."}]), not
        // `parts` — reading `parts` yields nothing and the reply comes back
        // "(no reply)" even though the model answered correctly.
        const content = event.message?.content ?? event.message?.parts ?? [];
        const text = content
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .join("");
        if (text) reply = text;
        if (/\[INPUT_REQUIRED\]/i.test(reply)) {
          inputRequired = true;
          reply = reply.replace(/\[INPUT_REQUIRED\]\s*/gi, "").trim();
        }
      } else if (event.type === "agent_end" && !event.willRetry) {
        resolveDone();
      }
    });
    const onAbort = () => {
      try {
        session.abort();
      } catch {
        /* ignore */
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([session.prompt(message), done]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsub();
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
    }
    return { reply: reply || "(no reply)", inputRequired };
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
  // -------------------------------------------------------------------------
  // Tools (outbound client) — always registered
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "a2a_call",
    label: "A2A Call",
    description:
      "Call a remote A2A (Agent2Agent) agent with a task message and return its reply. " +
      "Use to delegate work to other agents (Hermes, ADK, LangChain, CrewAI, any A2A peer). " +
      "Pass context_id to continue a multi-turn conversation.",
    promptSnippet: "delegate a task to a remote A2A agent and get its reply",
    promptGuidelines: [
      "Use for cross-agent task distribution and specialist delegation.",
      "The agent param is a configured peer name OR a full URL.",
    ],
    parameters: Type.Object({
      agent: agentParam,
      message: messageParam,
      context_id: contextIdParam,
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
      return { content: [{ type: "text" as const, text: a2aList({ cfg, piDir: piDir() }) }], details: {} };
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
      ctx.ui.notify(a2aList({ cfg, piDir: piDir() }), "info");
    },
  });

  pi.registerCommand("a2a-send", {
    description: "Send a task to an A2A agent: /a2a-send <agent> <message>",
    handler: async (args, ctx) => {
      const parts = String(args ?? "").trim().split(/\s+/);
      const agent = parts[0] ?? "";
      const message = parts.slice(1).join(" ");
      if (!agent || !message) {
        ctx.ui.notify("Usage: /a2a-send <agent> <message>", "error");
        return;
      }
      const cfg = cfgFor(ctx as unknown as ExtensionContext);
      ctx.ui.notify(await a2aCall({ cfg, piDir: piDir(), agent, message }), "info");
    },
  });

  pi.registerCommand("a2a-broadcast", {
    description: "Broadcast a task to multiple agents: /a2a-broadcast <msg> --agents a,b,c",
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
      const results = await Promise.all(
        agents.map((a) => a2aCall({ cfg, piDir: piDir(), agent: a, message })),
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
        `Server: ${server ? "running at " + server.url : cfg.server.enabled ? "enabled (not started)" : "disabled"}`,
        `Outbound: ${m.outbound_total} sent / ${m.inbound_total} replies`,
        `Tasks: ${m.tasks_completed} completed, ${m.tasks_failed} failed`,
        `Avg latency: ${m.avg_latency_ms}ms`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("a2a-config", {
    description: "Show current A2A config: /a2a-config",
    handler: async (_args, ctx) => {
      const cfg = cfgFor(ctx as unknown as ExtensionContext);
      ctx.ui.notify(
        [
          "Current A2A config:",
          `  server.enabled: ${cfg.server.enabled}`,
          `  server.port: ${cfg.server.port}`,
          `  server.host: ${cfg.server.host}`,
          `  peers: ${Object.keys(cfg.peers).join(", ") || "(none)"}`,
          "",
          "Edit ~/.pi/agent/settings.json under the 'a2a' key to configure peers and server.",
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("a2a-server", {
    description: "Manage the inbound A2A server: /a2a-server start|stop|status",
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
            runner: makeSessionRunner(ectx),
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
          "  /a2a-config                  Show config",
          "  /a2a-server start|stop|status  Manage inbound server",
          "",
          "Tools: a2a_call, a2a_discover, a2a_list, a2a_history, a2a_orchestrate",
        ].join("\n"),
        "info",
      );
    },
  });

  // -------------------------------------------------------------------------
  // Server lifecycle hooks (auto-start only when a2a.server.enabled)
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const cfg = cfgFor(ctx);
    if (!cfg.server.enabled) return;
    try {
      server = new A2AServer({
        cfg,
        ctx,
        cwd: ctx.cwd,
        piDir: piDir(),
        runner: makeSessionRunner(ctx),
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

  pi.on("session_shutdown", async () => {
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
