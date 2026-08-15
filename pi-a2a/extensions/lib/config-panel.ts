/**
 * Interactive A2A config panel (0.3.0) — an arrow-key toggle/edit form opened
 * by /a2a-config, mirroring Pi's built-in /config UX.
 *
 * Design: a generic row model (kind: toggle | string | number | action) with
 * pure buildRows/applyRows functions so all logic is unit-testable without a
 * TUI. The interactive shell (ctx.ui.custom) is a thin adapter over the model.
 *
 * IMPORTANT (learned the hard way): the panel must NOT call ctx.ui.input() /
 * ctx.ui.confirm() while it is displayed — those open editor-container dialogs
 * that render UNDER the overlay and fight the overlay focus. Instead the panel
 * embeds its own pi-tui Input component for value editing and saves directly
 * on Esc (no confirmation dialog). This matches the proven llama extension
 * pattern (single custom component, self-contained input handling).
 *
 * Keys: ↑/↓ navigate, Enter toggles booleans / edits strings+numbers (inline
 * input), Esc closes (saves when dirty).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, KeybindingsManager } from "@earendil-works/pi-tui";

import type { A2AConfig } from "./config";

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

export type PanelRowKind = "toggle" | "string" | "number" | "action";

export interface PanelRow {
  key: string;
  label: string;
  kind: PanelRowKind;
  value: unknown;
  /** Mask the value in render + inline-edit hint (for secrets/tokens). */
  mask?: boolean;
  set(v: unknown): void;
}

export interface PanelGroup {
  key: string;
  label: string;
  rows: PanelRow[];
}

/** Action descriptor (the "add peer" / "remove peer" rows). */
export interface PanelAction {
  label: string;
  /** Runs when the row is activated. `prompt` opens an inline input dialog
   *  (Enter confirms, Esc cancels → undefined) — actions must NOT call
   *  ctx.ui.input()/select()/confirm() while the panel overlay is showing. */
  run: (prompt: (label: string, onDone: (value: string | undefined) => void) => void) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Pure model builders — unit-testable without a TUI
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

  // Gateway group — reads use a non-mutating default view; setters materialize
  // `discovery.gateway` on first edit so toggling enabled (or entering a URL)
  // creates the block in the working config without clobbering an env-sourced
  // gateway on unrelated panel edits.
  const gwView = cfg.discovery.gateway ?? { enabled: false, url: "", token: "" };
  const gw = () => (cfg.discovery.gateway ??= { enabled: false, url: "", token: "" });
  const gateway: PanelRow[] = [
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
  ];

  const identity: PanelRow[] = [
    row("selfIdentity", "Caller identity", "string", cfg.selfIdentity, (v) => {
      cfg.selfIdentity = String(v ?? "");
    }),
  ];

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
    { key: "gateway", label: "Gateway", rows: gateway },
    { key: "identity", label: "Identity", rows: identity },
    { key: "peers", label: "Peers", rows: peers },
    { key: "ui", label: "UI", rows: ui },
  ];
}

function row(key: string, label: string, kind: PanelRowKind, value: unknown, set: (v: unknown) => void, opts: { mask?: boolean } = {}): PanelRow {
  // The setter updates BOTH the backing config and row.value so the render
  // reflects the change immediately (a stale value made toggles appear dead).
  const r: PanelRow = {
    key,
    label,
    kind,
    value,
    mask: opts.mask,
    set(v: unknown) {
      set(v);
      r.value = kind === "number" ? toInt(v, Number(r.value)) : v;
    },
  };
  return r;
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n) ? (n as number) : fallback;
}

/** Apply every row's setter to a fresh config (for tests / "apply" flows). */
export function applyRows(cfg: A2AConfig, groups: PanelGroup[]): A2AConfig {
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.kind !== "action") r.set(r.value);
    }
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Interactive shell (thin adapter over the model)
// ---------------------------------------------------------------------------

export interface ConfigPanelOpts {
  ctx: ExtensionContext;
  cfg: A2AConfig;
  actions?: Record<string, PanelAction>;
  /** Called when the panel saves (Esc with dirty). Second arg: row keys the
   *  user actually edited (for secret-persistence decisions). */
  onSave?: (saved: boolean, editedKeys?: Set<string>) => void;
}

/**
 * Open the interactive config panel via ctx.ui.custom.
 * Resolves when the panel closes (Esc — saves when dirty).
 */
export function openConfigPanel(opts: ConfigPanelOpts): Promise<void> {
  const { ctx, cfg, actions, onSave } = opts;
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("Config panel requires interactive TUI mode.", "warning");
    onSave?.(false);
    return Promise.resolve();
  }
  return ctx.ui.custom((tui, theme, keybindings, done) => {
    const model = new ConfigPanelModel(buildRows(cfg, actions), theme);
    model.keybindings = keybindings;
    model.onRequestRender = () => tui.requestRender();
    model.onSave = () => {
      try {
        onSave?.(true, model.editedKeys);
      } catch (e: any) {
        ctx.ui.notify(`Save failed: ${e?.message || e}`, "error");
        return;
      }
      done();
    };
    // Action rows run with an inline prompt (Enter confirms, Esc cancels →
    // undefined). Actions must NOT use ctx.ui.input/select/confirm here —
    // those render under the overlay and break the panel. onAction is an
    // error-reporting hook (activate() drives the action itself).
    model.onAction = async (row) => {
      try {
        await row.set((label: string, onDone: (v: string | undefined) => void) => {
          model.prompt(label, onDone);
        });
        // Actions mutate config (add/remove peer) — always mark dirty so Esc
        // triggers save.
        model.dirty = true;
        model.requestRender();
      } catch (e: any) {
        ctx.ui.notify(`Action failed: ${e?.message || e}`, "error");
      }
    };
    model.onClose = () => {
      // Save when dirty (no confirm dialog — Esc = save-and-close; Esc within
      // an inline input cancels the edit instead). Matches the llama
      // extension's no-nested-dialog pattern.
      if (model.dirty) {
        model.onSave?.();
      } else {
        done();
      }
    };
    return model;
  });
}

/** Coerce a raw input string to the row kind's value. */
export function kindValue(kind: PanelRowKind, raw: string): unknown {
  if (kind === "number") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : raw;
  }
  if (kind === "toggle") return /^(1|true|yes|on)$/i.test(raw.trim());
  return raw;
}

// ---------------------------------------------------------------------------
// Component implementation
// ---------------------------------------------------------------------------

interface PanelTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

/** How many rows fit on screen before the list scrolls. 18 shows the two
 *  largest groups (SERVER 11 + DISCOVERY 7) together on the first screen;
 *  the next screen fits all remaining groups (GATEWAY+IDENTITY+PEERS+UI).
 *  Whole groups only — a group is never split across screens. */
const MAX_VISIBLE_ROWS = 18;

export class ConfigPanelModel implements Component {
  onRequestRender: (() => void) | null = null;
  onChanged: (() => void) | null = null;
  onSave: (() => void) | null = null;
  onAction: ((row: PanelRow) => Promise<void>) | null = null;
  onClose: (() => void) | null = null;
  keybindings: KeybindingsManager | null = null;

  dirty = false;
  width = 80; // overlay width hint
  /** Keys of rows the user actually edited (for secret-persistence decisions). */
  editedKeys = new Set<string>();
  private groups: PanelGroup[];
  private theme: PanelTheme | null;
  private flat: PanelRow[] = [];
  private selected = 0;
  private scroll = 0; // first visible row index
  private editing: PanelRow | null = null;
  private input: Input | null = null;
  private pendingPrompt: { label: string; onDone: (value: string | undefined) => void } | null = null;
  private _focused = false;

  constructor(groups: PanelGroup[], theme: PanelTheme | null) {
    this.groups = groups;
    this.theme = theme;
    this.rebuildFlat();
  }

  // Focusable interface (TUI checks `"focused" in component`).
  get focused(): boolean {
    return this._focused;
  }

  set focused(v: boolean) {
    this._focused = v;
    if (this.input) this.input.focused = v;
  }

  private rebuildFlat(): void {
    this.flat = this.groups.flatMap((g) => g.rows);
    if (this.selected >= this.flat.length) this.selected = Math.max(0, this.flat.length - 1);
  }

  requestRender(): void {
    this.onRequestRender?.();
  }

  invalidate(): void {
    this.rebuildFlat();
  }

  private color(token: string, text: string): string {
    return this.theme?.fg ? this.theme.fg(token, text) : text;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const w = Math.max(20, width);
    const bold = this.theme?.bold ? this.theme.bold.bind(this.theme) : (t: string) => t;
    lines.push(this.color("accent", bold("A2A Configuration")));
    lines.push(this.color("dim", "↑/↓ navigate · Enter edit/toggle · Esc save & close"));
    lines.push("");

    // Prompt mode (action input): show only the prompt + inline input.
    if (this.pendingPrompt) {
      const inputLines = this.input ? this.input.render(w - 4) : ["…"];
      lines.push(this.color("text", `${this.pendingPrompt.label}: ${inputLines[0] ?? ""}`));
      lines.push(this.color("dim", "Enter confirm · Esc cancel"));
      lines.push("");
      if (this.dirty) lines.push(this.color("warning", "● unsaved changes"));
      return lines.map((l) => truncateToWidth(l, w));
    }

    // Group-based windowing: render WHOLE groups (header + all its rows) so
    // categories stay coherent like the settings.json layout — never split a
    // group mid-way with its header floating above unrelated rows. Scrolling
    // slides the window one group at a time so the selected group is always
    // visible and navigation stays continuous.
    const flat = this.flat;
    const total = flat.length;
    const budget = MAX_VISIBLE_ROWS; // rows budget; each header costs 1

    // Cumulative absolute row index where each group starts.
    const groupStarts: number[] = [];
    let acc = 0;
    for (const g of this.groups) {
      groupStarts.push(acc);
      acc += g.rows.length;
    }

    // Group containing the current selection.
    let selGroup = 0;
    for (let i = 0; i < this.groups.length; i++) {
      if (this.selected < groupStarts[i]! + this.groups[i]!.rows.length) {
        selGroup = i;
        break;
      }
    }

    // Fit as many whole groups as the budget allows, sliding `first` forward
    // (one group at a time) until the selected group is visible.
    let first = 0;
    let last = -1; // last group index that fits
    for (;;) {
      let used = 0;
      let fit = first - 1;
      for (let i = first; i < this.groups.length; i++) {
        const cost = 1 + this.groups[i]!.rows.length;
        if (used + cost > budget) break;
        used += cost;
        fit = i;
      }
      last = fit;
      if (selGroup <= last || first >= selGroup) break;
      first++;
    }

    const visibleStart = groupStarts[first]!;
    const visibleEnd = groupStarts[last + 1] ?? total;
    this.scroll = visibleStart;

    // Render the visible groups with correct absolute indices.
    for (let i = first; i <= last && i < this.groups.length; i++) {
      const g = this.groups[i]!;
      lines.push(this.color("muted", g.label.toUpperCase()));
      for (let j = 0; j < g.rows.length; j++) {
        const absIdx = groupStarts[i]! + j;
        const selected = absIdx === this.selected;
        lines.push(this.renderRow(g.rows[j]!, selected, w));
      }
    }

    if (total > visibleEnd - visibleStart) {
      lines.push(this.color("dim", `… ${visibleStart + 1}-${visibleEnd} of ${total}`));
    }
    lines.push("");
    if (this.dirty) {
      lines.push(this.color("warning", "● unsaved changes — Esc saves"));
    } else {
      lines.push(this.color("dim", "no changes"));
    }
    // Truncate every line to the overlay width — the TUI throws when a custom
    // component renders a line wider than the terminal (long peer URLs etc.).
    return lines.map((l) => truncateToWidth(l, w));
  }

  private renderRow(r: PanelRow, selected: boolean, width: number): string {
    const mark = selected ? this.color("accent", "›") : " ";
    const masked = r.mask && String(r.value ?? "") !== "";
    if (this.editing === r) {
      // Inline input row — show the input's own render (single line) plus the
      // current value as a hint (the input starts empty so typing replaces).
      const inputLines = this.input ? this.input.render(width - 4) : ["…"];
      const hint = this.color("dim", masked ? " (was: ••••)" : ` (was: ${String(r.value ?? "")})`);
      return `${mark} ${r.label}: ${inputLines[0] ?? ""}${hint}`;
    }
    let valueText: string;
    if (r.kind === "toggle") {
      valueText = r.value ? this.color("success", "on") : this.color("dim", "off");
    } else if (r.kind === "action") {
      valueText = this.color("accent", "press Enter");
    } else if (masked) {
      valueText = this.color("dim", "••••");
    } else {
      valueText = String(r.value ?? "");
    }
    const rowText = `${mark} ${r.label}: ${valueText}`;
    return selected ? this.color("text", rowText) : this.color("dim", rowText);
  }

  handleInput(data: string): void {
    // While editing or prompting, route ALL keys to the inline input.
    if ((this.editing || this.pendingPrompt) && this.input) {
      this.input.handleInput(data);
      this.requestRender();
      return;
    }
    const kb = this.keybindings;
    if (kb) {
      if (kb.matches(data, "tui.select.up")) return this.move(-1);
      if (kb.matches(data, "tui.select.down")) return this.move(1);
      if (kb.matches(data, "tui.select.cancel")) return this.onClose?.();
      if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.input.submit")) {
        void this.activate();
        return;
      }
      return;
    }
    // Fallback raw parsing (tests / non-standard keybindings).
    if (data === "\u001b[A" || data === "\u001bOA" || data === "k") return this.move(-1);
    if (data === "\u001b[B" || data === "\u001bOB" || data === "j") return this.move(1);
    if (data === "\u001b" || data === "\u0003") return this.onClose?.();
    if (data === "\r" || data === "\n") void this.activate();
  }

  private async activate(): Promise<void> {
    const row = this.flat[this.selected];
    if (!row) return;
    if (row.kind === "action") {
      // Route through onAction (wired by openConfigPanel) which passes the
      // inline prompt to the action's run(). Actions must NOT call
      // ctx.ui.input/select/confirm — those render under the overlay.
      await this.onAction?.(row);
    } else if (row.kind === "toggle") {
      row.set(!row.value);
      this.dirty = true;
      this.editedKeys.add(row.key);
      this.onChanged?.();
      this.requestRender();
    } else {
      this.startEdit(row);
    }
  }

  /** Begin an inline prompt (for action rows like add/remove peer). */
  prompt(label: string, onDone: (value: string | undefined) => void): void {
    this.pendingPrompt = { label, onDone };
    this.input = new Input();
    this.input.onSubmit = (raw: string) => {
      const p = this.pendingPrompt;
      this.pendingPrompt = null;
      this.input = null;
      p?.onDone(raw);
      this.requestRender();
    };
    this.input.onEscape = () => {
      const p = this.pendingPrompt;
      this.pendingPrompt = null;
      this.input = null;
      p?.onDone(undefined);
      this.requestRender();
    };
    this.input.focused = this._focused;
    this.requestRender();
  }

  /** Begin inline editing of a string/number row. The input starts empty so
   *  typing replaces the value (standard "type a new port" UX); the old value
   *  is shown as a hint on the row. */
  private startEdit(row: PanelRow): void {
    this.editing = row;
    this.input = new Input();
    this.input.onSubmit = (raw: string) => {
      // Empty submit on a masked (secret) row = keep the existing value.
      // The old secret is invisible (rendered as ••••), so a blank enter
      // must never wipe it.
      if (row.mask && raw === "") {
        this.editing = null;
        this.input = null;
        this.requestRender();
        return;
      }
      const next = kindValue(row.kind, raw);
      if (String(next) !== String(row.value)) {
        row.set(next);
        this.dirty = true;
        this.editedKeys.add(row.key);
        this.onChanged?.();
      }
      this.editing = null;
      this.input = null;
      this.requestRender();
    };
    this.input.onEscape = () => {
      this.editing = null;
      this.input = null;
      this.requestRender();
    };
    this.input.focused = this._focused;
    this.requestRender();
  }

  private move(delta: number): void {
    const next = this.selected + delta;
    if (next >= 0 && next < this.flat.length) {
      this.selected = next;
      this.requestRender();
    }
  }
}
