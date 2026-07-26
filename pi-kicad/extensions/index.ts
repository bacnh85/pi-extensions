import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getDaemon } from "./lib/daemon.js";
import {
  callKonnect,
  mapContent,
  probeHealth,
  type KonnectCallResult,
} from "./lib/konnect-client.js";
import { runBatch, summarizeBatch, type BatchOp } from "./lib/batch.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function piKicadExtension(pi: ExtensionAPI) {
  // ── kicad_call ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "kicad_call",
    label: "KiCad (Konnect)",
    description:
      "Drive KiCad schematic/PCB design via the Konnect binary. Call any Konnect " +
        "tool by name (schematic capture, PCB layout, ERC/DRC, exports, design review, " +
        "JLCPCB parts, Freerouting, reference circuits). Schematic tools edit .kicad_sch " +
        "directly (no KiCad UI needed); PCB tools require KiCad 10 running with its API enabled.",
    promptSnippet: "Drive KiCad via Konnect (schematic, layout, ERC/DRC, Gerber export)",
    promptGuidelines: [
      "Konnect exposes 185 tools in toolsets. Only a small starter kit is loaded; call " +
        "list_toolboxes to see toolsets, then load_toolset(\"<name>\") before using its tools " +
        "(e.g. load_toolset(\"sch_components\") before add_schematic_component).",
      "unload_toolset(\"<name>\") prunes tools to keep context small when switching tasks.",
      "If a tool errors with 'toolset not loaded', call load_toolset with the named toolset, then retry.",
      "Prefer batch_* tools (batch_add_wire, batch_delete, bulk_move_schematic_components) to cut file read/write cycles.",
      "Schematic work is file-based and needs no running KiCad; PCB layout/routing needs KiCad 10 open with " +
        "Preferences → Plugins → 'Enable KiCad API' on, and the target board open.",
      "Design flow: create/open project → schematic capture → annotate → run_erc → fix violations → " +
        "update PCB from schematic → layout/route → get_drc_violations → fix → export_gerber/export_pdf.",
      "Diagnose your own tool failures with get_recent_calls and server_stats.",
    ],
    parameters: Type.Object({
      tool: Type.String({
        description: "Konnect tool name, e.g. add_schematic_component, run_erc, export_gerber, load_toolset.",
        minLength: 1,
      }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Arguments object for the tool. Omit for tools that take none.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: "Per-call timeout in ms (default 120000). Exports/DRC may need more.",
          minimum: 1000,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const daemon = getDaemon();
      const port = await daemon.ensure();
      const result = (await callKonnect({
        port,
        method: "tools/call",
        params: { name: params.tool, arguments: params.arguments ?? {} },
        signal: signal ?? undefined,
        timeoutMs: params.timeout_ms ?? DEFAULT_CALL_TIMEOUT_MS,
      })) as KonnectCallResult;

      const { piContent, images } = mapContent(result?.content, { maxChars: MAX_OUTPUT_CHARS });
      const content =
        piContent.length > 0
          ? piContent
          : [{ type: "text" as const, text: `(tool '${params.tool}' returned no content)` }];

      return {
        content,
        details: {
          tool: params.tool,
          isError: result?.isError === true,
          images: images.length,
        },
      };
    },
  });

  // ── kicad_batch ─────────────────────────────────────────────────────
  // Konnect's file-mutating tools race under concurrency (atomic-rename window).
  // This runs N tool calls SEQUENTIALLY (await each) so multi-step schematic
  // capture works in one shot instead of many serial kicad_call messages.
  pi.registerTool({
    name: "kicad_batch",
    label: "KiCad Batch",
    description:
      "Run multiple Konnect tool calls SEQUENTIALLY in one shot (each awaits before the next, " +
        "so same-file writes don't race). Use for multi-step schematic capture: create symbols, " +
        "place components, wire nets. Returns a per-op summary; full parsed results in details.",
    promptSnippet: "Run several KiCad/Konnect tool calls sequentially in one shot",
    promptGuidelines: [
      "Parallel kicad_call calls on the same file lose data (Konnect's atomic-rename race). Use kicad_batch for any multi-step flow so ops run strictly sequentially.",
      "Each op is {tool, arguments}. Check isError per op in the summary; full parsed payloads are in details.results[].result.",
      "For wiring that needs pin coordinates: run placement + batch_get_schematic_pin_locations in one batch, read the pin coords from details, then connect_to_net in a second batch using those coords.",
    ],
    parameters: Type.Object({
      ops: Type.Array(
        Type.Object({
          tool: Type.String({ description: "Konnect tool name" }),
          arguments: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for the tool" }),
          ),
        }),
        { minItems: 1, maxItems: 60 },
      ),
      stop_on_error: Type.Optional(
        Type.Boolean({ description: "Stop after the first error (default false: run all, report each)." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const daemon = getDaemon();
      const port = await daemon.ensure();
      const outcome = await runBatch(
        params.ops as BatchOp[],
        (op) =>
          callKonnect({
            port,
            method: "tools/call",
            params: { name: op.tool, arguments: op.arguments ?? {} },
            signal: signal ?? undefined,
            timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
          }),
        { stopOnError: params.stop_on_error },
      );
      return {
        content: [{ type: "text" as const, text: summarizeBatch(outcome) }],
        details: { errors: outcome.errors, stopped: outcome.stopped, results: outcome.results },
      };
    },
  });

  // ── kicad_status ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "kicad_status",
    label: "KiCad Status",
    description:
      "Check and wire up the KiCad/Konnect bridge: resolve the Konnect binary, kicad-cli, " +
        "and IPC socket; start/health-check the local HTTP daemon; report version and active " +
        "tool count. Use this first when something isn't working, or to (re)start the daemon.",
    promptSnippet: "Check KiCad/Konnect bridge health and wiring",
    promptGuidelines: [
      "Call this first if kicad_call fails, or to confirm the daemon is up and KiCad IPC is reachable.",
      "restart:true stops and relaunches the daemon (e.g. after changing KICAD_API_SOCKET or KiCad config).",
    ],
    parameters: Type.Object({
      restart: Type.Optional(
        Type.Boolean({
          description: "Stop and relaunch the daemon, then report status. Default false.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const daemon = getDaemon();
      const cfg = daemon.getResolvedConfig();
      let daemonError = "";

      if (params.restart) {
        try {
          await daemon.restart();
        } catch (err) {
          daemonError = errMsg(err);
        }
      } else {
        try {
          await daemon.ensure();
        } catch (err) {
          daemonError = errMsg(err);
        }
      }

      const status = await daemon.getStatus();
      let version: string | undefined;
      let activeTools: number | undefined;
      if (status.healthy && status.port !== null) {
        try {
          const init = (await callKonnect({ port: status.port, method: "initialize", timeoutMs: 5000 })) as
            | { serverInfo?: { version?: string } }
            | undefined;
          version = init?.serverInfo?.version;
          const list = (await callKonnect({ port: status.port, method: "tools/list", timeoutMs: 5000 })) as
            | { tools?: unknown[] }
            | undefined;
          activeTools = list?.tools?.length;
        } catch (err) {
          daemonError = daemonError || errMsg(err);
        }
      }

      const lines: string[] = ["KiCad / Konnect bridge status", "─".repeat(40)];
      lines.push(`konnect binary: ${cfg.konnectBinary ?? "(not found — set KONNECT_BINARY or install via KiCad 10 PCM)"}`);
      lines.push(`kicad-cli:       ${cfg.kicadCli ?? "(not found — set KICAD_CLI or install KiCad)"}`);
      lines.push(`ipc socket:      ${cfg.ipcSocket ?? "(auto-detect from KICAD_API_SOCKET)"}`);
      lines.push(`symbol dir:      ${cfg.symbolDir ?? "(none)"}  <- create symbols here (lib_id "<file>:<sym>")`);
      lines.push(`daemon:          ${status.running ? (status.reused ? "reused (external)" : "managed") : "down"}`);
      lines.push(`healthy:         ${status.healthy}`);
      lines.push(`port:            ${status.port ?? "—"}`);
      lines.push(`pid:             ${status.pid ?? "—"}`);
      if (version) lines.push(`konnect version: ${version}`);
      if (activeTools !== undefined) lines.push(`active tools:    ${activeTools}`);
      if (status.healthy) {
        lines.push("");
        lines.push("KiCad IPC (PCB tools): " + (cfg.ipcSocket ? "socket configured; confirm KiCad 10 is running with API enabled" : "rely on KICAD_API_SOCKET env / KiCad auto-detect; open a board in KiCad 10 for PCB tools"));
      }
      if (daemonError) {
        lines.push("");
        lines.push(`error: ${daemonError}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          ...status,
          version,
          activeTools,
          error: daemonError || undefined,
        },
      };
    },
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-export the raw client for direct use / tests.
export { callKonnect, mapContent, probeHealth } from "./lib/konnect-client.js";
