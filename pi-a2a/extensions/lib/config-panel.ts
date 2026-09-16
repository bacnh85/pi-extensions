/**
 * A2A config panel rows (kernel lives in @bacnh85/pi-config-panel).
 *
 * This module builds the A2A row model for the shared panel kernel: every
 * group/row maps a settings.json `a2a` field to a toggle/string/number row
 * whose setter mutates the working config in place. Action rows (add/remove
 * peer, add/remove gateway) are defined here and wired by index.ts.
 *
 * Keys: ↑/↓ navigate, Enter toggles booleans / edits strings+numbers (inline
 * input), Esc closes (saves when dirty).
 */

import { row, toInt } from "@bacnh85/pi-config-panel";
import type { PanelAction, PanelGroup, PanelRow } from "@bacnh85/pi-config-panel";

import type { A2AConfig } from "./config";

export type { PanelAction, PanelGroup, PanelRow };

// Re-export the kernel API surface index.ts/tests use; the A2A panel adds
// only buildRows + the openPanel wrapper below.
export { makeOnAction, kindValue, applyRows, ConfigPanelModel } from "@bacnh85/pi-config-panel";
import { openConfigPanel } from "@bacnh85/pi-config-panel";
import type { ConfigPanelOpts } from "@bacnh85/pi-config-panel";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Row model builders — unit-testable without a TUI
// ---------------------------------------------------------------------------

/**
 * Build the panel row model from a config. Row setters mutate the passed
 * config in place so the caller keeps a working copy and marks dirty.
 */
export function buildRows(
  cfg: A2AConfig,
  actions: Record<string, PanelAction> = {},
): PanelGroup[] {
  const server: PanelRow[] = [
    row("server.enabled", "Server enabled", "toggle", cfg.server.enabled, (v) => {
      cfg.server.enabled = Boolean(v);
    }),
    row("server.port", "Port", "number", cfg.server.port, (v) => {
      cfg.server.port = toInt(v, cfg.server.port);
    }),
    row("server.portFallback", "Port fallback", "number", cfg.server.portFallback, (v) => {
      cfg.server.portFallback = toInt(v, cfg.server.portFallback);
    }),
    row("server.host", "Bind host", "string", cfg.server.host, (v) => {
      cfg.server.host = String(v ?? "");
    }),
    row("server.agentName", "Agent name", "string", cfg.server.agentName, (v) => {
      cfg.server.agentName = String(v ?? "");
    }),
    row("server.replyTimeoutSec", "Reply timeout (s)", "number", cfg.server.replyTimeoutSec, (v) => {
      cfg.server.replyTimeoutSec = toInt(v, cfg.server.replyTimeoutSec);
    }),
    row("server.asyncTimeoutSec", "Async timeout (s)", "number", cfg.server.asyncTimeoutSec, (v) => {
      cfg.server.asyncTimeoutSec = toInt(v, cfg.server.asyncTimeoutSec);
    }),
    row("server.maxConcurrent", "Max concurrent", "number", cfg.server.maxConcurrent, (v) => {
      cfg.server.maxConcurrent = toInt(v, cfg.server.maxConcurrent);
    }),
    row("server.allowAllUsers", "Allow all users", "toggle", cfg.server.allowAllUsers, (v) => {
      cfg.server.allowAllUsers = Boolean(v);
    }),
    row("server.maxPingpongTurns", "Max ping-pong turns", "number", cfg.server.maxPingpongTurns, (v) => {
      cfg.server.maxPingpongTurns = toInt(v, cfg.server.maxPingpongTurns);
    }),
    row("server.rateLimitPerMin", "Rate limit /min", "number", cfg.server.rateLimitPerMin, (v) => {
      cfg.server.rateLimitPerMin = toInt(v, cfg.server.rateLimitPerMin);
    }),
  ];

  const discovery: PanelRow[] = [
    row("discovery.local.enabled", "Local registry", "toggle", cfg.discovery.local.enabled, (v) => {
      cfg.discovery.local.enabled = Boolean(v);
    }),
    row("discovery.local.heartbeatSec", "Heartbeat (s)", "number", cfg.discovery.local.heartbeatSec, (v) => {
      cfg.discovery.local.heartbeatSec = toInt(v, cfg.discovery.local.heartbeatSec);
    }),
    row("discovery.local.ttlSec", "Registry TTL (s)", "number", cfg.discovery.local.ttlSec, (v) => {
      cfg.discovery.local.ttlSec = toInt(v, cfg.discovery.local.ttlSec);
    }),
    row("discovery.mdns.enabled", "mDNS broadcast", "toggle", cfg.discovery.mdns.enabled, (v) => {
      cfg.discovery.mdns.enabled = Boolean(v);
    }),
    row("discovery.mdns.serviceType", "mDNS service type", "string", cfg.discovery.mdns.serviceType, (v) => {
      cfg.discovery.mdns.serviceType = String(v ?? "");
    }),
    row("discovery.enrichCard", "Enrich Agent Card", "toggle", cfg.discovery.enrichCard, (v) => {
      cfg.discovery.enrichCard = Boolean(v);
    }),
  ];

  // Gateway group — legacy `discovery.gateway` block (pre-0.6.0 path, still
  // used by env-sourced config). Reads use a non-mutating default view; setters
  // materialize the block on first edit so toggling enabled (or entering a URL)
  // creates it in the working config without clobbering an env-sourced gateway
  // on unrelated panel edits. An INERT block (all-empty + disabled, the
  // loadConfig-materialized placeholder) renders nothing — the live map is in
  // the Gateways group below.
  const gwView = cfg.discovery.gateway ?? { enabled: false, url: "", token: "" };
  const gw = () => (cfg.discovery.gateway ??= { enabled: false, url: "", token: "" });
  // Live = any field differs from the inert placeholder loadConfig materializes
  // (enabled/url/token — but also name/upstreamToken/heartbeatSec/channel: a
  // block like {enabled:false, channel:false} carries real config and must
  // stay editable).
  const gatewayLive = cfg.discovery.gateway != null &&
    (Boolean(gwView.enabled) || Boolean(gwView.url) || Boolean(gwView.token) ||
      gwView.name != null || gwView.upstreamToken != null ||
      (gwView.heartbeatSec ?? 60) !== 60 || (gwView.channel ?? true) !== true);
  const gateway: PanelRow[] = gatewayLive ? [
    row("gateway.enabled", "Gateway registration", "toggle", gwView.enabled, (v) => {
      gw().enabled = Boolean(v);
    }),
    row("gateway.url", "Gateway URL", "string", gwView.url, (v) => {
      gw().url = String(v ?? "");
    }),
    row("gateway.token", "API token", "string", gwView.token, (v) => {
      gw().token = String(v ?? "");
    }, { mask: true }),
    row("gateway.name", "Peer name", "string", gwView.name ?? "", (v) => {
      gw().name = v ? String(v) : undefined;
    }),
    row("gateway.upstreamToken", "Upstream token", "string", gwView.upstreamToken ?? "", (v) => {
      gw().upstreamToken = v ? String(v) : undefined;
    }, { mask: true }),
    row("gateway.heartbeatSec", "Heartbeat (s)", "number", gwView.heartbeatSec ?? 60, (v) => {
      gw().heartbeatSec = toInt(v, gw().heartbeatSec ?? 60);
    }),
    row("gateway.channel", "Reverse channel", "toggle", gwView.channel ?? true, (v) => {
      gw().channel = Boolean(v);
    }),
  ] : [];

  const identity: PanelRow[] = [
    row("selfIdentity", "Caller identity", "string", cfg.selfIdentity, (v) => {
      cfg.selfIdentity = String(v ?? "");
    }),
  ];

  // Multiple gateways (0.6.0) — one row block per `discovery.gateways` entry,
  // keyed `gw.<key>.<field>`. Setters materialize the map entry on first edit.
  const gateways: PanelRow[] = [];
  for (const [key, entry] of Object.entries(cfg.discovery.gateways ?? {})) {
    const view = entry ?? { enabled: false, url: "", token: "" };
    const g = () => (cfg.discovery.gateways![key] ??= { enabled: false, url: "", token: "" });
    gateways.push(
      row(`gw.${key}.enabled`, `[${key}] Registration`, "toggle", view.enabled, (v) => {
        g().enabled = Boolean(v);
      }),
      row(`gw.${key}.url`, `[${key}] URL`, "string", view.url, (v) => {
        g().url = String(v ?? "");
      }),
      row(`gw.${key}.token`, `[${key}] API token`, "string", view.token, (v) => {
        g().token = String(v ?? "");
      }, { mask: true }),
      row(`gw.${key}.name`, `[${key}] Peer name`, "string", view.name ?? "", (v) => {
        g().name = v ? String(v) : undefined;
      }),
      row(`gw.${key}.upstreamToken`, `[${key}] Upstream token`, "string", view.upstreamToken ?? "", (v) => {
        g().upstreamToken = v ? String(v) : undefined;
      }, { mask: true }),
      row(`gw.${key}.heartbeatSec`, `[${key}] Heartbeat (s)`, "number", view.heartbeatSec ?? 60, (v) => {
        g().heartbeatSec = toInt(v, g().heartbeatSec ?? 60);
      }),
      row(`gw.${key}.channel`, `[${key}] Reverse channel`, "toggle", view.channel ?? true, (v) => {
        g().channel = Boolean(v);
      }),
    );
  }
  if (actions.addGateway) {
    gateways.push({ key: "action.addGateway", label: "+ Add gateway", kind: "action", value: undefined, set: (p) => actions.addGateway!.run(p as never) });
  }
  if (actions.removeGateway) {
    gateways.push({ key: "action.removeGateway", label: "− Remove gateway", kind: "action", value: undefined, set: (p) => actions.removeGateway!.run(p as never) });
  }

  const peers: PanelRow[] = [];
  for (const [name, p] of Object.entries(cfg.peers)) {
    peers.push(
      row(`peer.${name}.url`, `Peer ${name} URL`, "string", p.url, (v) => {
        p.url = String(v ?? "");
      }),
    );
  }
  if (actions.addPeer) {
    peers.push({ key: "action.addPeer", label: "+ Add peer", kind: "action", value: undefined, set: (p) => actions.addPeer!.run(p as never) });
  }
  if (actions.removePeer) {
    peers.push({ key: "action.removePeer", label: "− Remove peer", kind: "action", value: undefined, set: (p) => actions.removePeer!.run(p as never) });
  }

  const ui: PanelRow[] = [
    row("ui.transcript", "Transcript messages", "toggle", cfg.ui.transcript, (v) => {
      cfg.ui.transcript = Boolean(v);
    }),
  ];

  return [
    { key: "server", label: "Server", rows: server },
    { key: "discovery", label: "Discovery", rows: discovery },
    ...(gatewayLive ? [{ key: "gateway", label: "Gateway (discovery.gateway)", rows: gateway }] : []),
    { key: "gateways", label: "Gateways (discovery.gateways)", rows: gateways },
    { key: "identity", label: "Identity", rows: identity },
    { key: "peers", label: "Peers", rows: peers },
    { key: "ui", label: "UI", rows: ui },
  ];
}

// ---------------------------------------------------------------------------
// Panel open (kernel shell, A2A build + title)
// ---------------------------------------------------------------------------

export function openPanel(
  ctx: ExtensionContext,
  cfg: A2AConfig,
  actions: Record<string, PanelAction>,
  onSave: (saved: boolean, editedKeys?: Set<string>) => void,
): Promise<void> {
  const opts: ConfigPanelOpts<A2AConfig> = {
    ctx,
    cfg,
    build: buildRows,
    actions,
    title: "A2A Configuration",
    onSave,
  };
  return openConfigPanel(opts);
}
