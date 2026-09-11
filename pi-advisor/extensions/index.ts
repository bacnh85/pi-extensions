import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

import { loadConfig, migrateLegacyAdvisorModel, saveModels } from "./lib/config";
import { isSeverity, sanitizeNote, type Severity } from "./lib/emission-guard";
import { REVIEW_ENTRY, createRuntime, reseedCursor, reviewTurn, type IsolatedCall, type WatcherRuntime } from "./lib/watcher";
import { registerAdvisor } from "./commands/advisor";

// ponytail: test-only injection — real calls use runIsolated (watcher's default); tests swap it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let testIsolated: IsolatedCall | undefined;
export function __setIsolatedForTest(fn: IsolatedCall | undefined): void {
  testIsolated = fn;
}

interface NoteData {
  severity: Severity;
  note: string;
  timestamp: number;
  downgraded?: boolean;
  deferred?: boolean;
}

export default function piAdvisor(pi: ExtensionAPI): void {
  let runtime: WatcherRuntime | undefined;
  let runtimeSessionId: string | undefined;
  // Session-scoped watch flag — config default, toggled by /advisor on|off, not persisted.
  let watchEnabled = true;
  let migrationAttempted = false;

  pi.registerEntryRenderer<NoteData>(REVIEW_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data && isSeverity(entry.data.severity) && typeof entry.data.note === "string"
      ? { ...entry.data, note: sanitizeNote(entry.data.note) }
      : { severity: "nit" as Severity, note: "(unavailable)", timestamp: 0 };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const label = data.downgraded ? "Advisor (downgraded)" : data.deferred ? "Advisor (deferred — next turn)" : "Advisor";
    const sev = data.severity === "blocker"
      ? theme.fg("error", data.severity)
      : data.severity === "concern"
        ? theme.fg("warning", data.severity)
        : theme.fg("dim", data.severity);
    box.addChild(new Text(`${theme.fg("accent", theme.bold(label))} ${sev} ${theme.fg("dim", data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "")}`, 0, 0));
    box.addChild(new Markdown(data.note, 0, 0, getMarkdownTheme()));
    if (expanded && data.timestamp) box.addChild(new Text(theme.fg("dim", new Date(data.timestamp).toLocaleString()), 0, 0));
    return box;
  });

  // Message renderer for next-turn asides (LLM-visible deferred notes). Guard for
  // older Pi builds/tests that only mock registerEntryRenderer. In the TUI the
  // deferred message is display:false (the immediate card is the visible surface),
  // so this is a fallback for non-TUI surfaces that render flushed messages.
  if (typeof (pi as unknown as { registerMessageRenderer?: unknown }).registerMessageRenderer === "function") {
    (pi as unknown as { registerMessageRenderer: typeof pi.registerEntryRenderer }).registerMessageRenderer<NoteData>(REVIEW_ENTRY, (message, { expanded }, theme) => {
      const raw = (message as unknown as { details?: unknown }).details as NoteData | undefined;
      const data = raw && isSeverity(raw.severity) && typeof raw.note === "string"
        ? { ...raw, note: sanitizeNote(raw.note) }
        : { severity: "nit" as Severity, note: "(unavailable)", timestamp: 0 };
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      const label = data.downgraded ? "Advisor (downgraded)" : data.deferred ? "Advisor (deferred — next turn)" : "Advisor";
      const sev = data.severity === "blocker"
        ? theme.fg("error", data.severity)
        : data.severity === "concern"
          ? theme.fg("warning", data.severity)
          : theme.fg("dim", data.severity);
      box.addChild(new Text(`${theme.fg("accent", theme.bold(label))} ${sev} ${theme.fg("dim", data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "")}`, 0, 0));
      box.addChild(new Markdown(data.note, 0, 0, getMarkdownTheme()));
      if (expanded && data.timestamp) box.addChild(new Text(theme.fg("dim", new Date(data.timestamp).toLocaleString()), 0, 0));
      return box;
    });
  }

  pi.on("before_agent_start", (event, ctx: ExtensionContext): any => {
    // Headless runs can't receive watch notes anymore — don't make them pay
    // dead prompt text claiming otherwise.
    if (ctx.mode !== "tui" || !watchEnabled || !runtime || runtime.models.length === 0 || runtime.stats.paused) return;
    // Every turn the agent sees the authority line (static per session,
    // cache-safe): messages starting 'Advisor review' are reviewer findings.
    const line = "Advisor notes: messages starting 'Advisor review' are authoritative reviewer findings. Fix or explicitly justify ignoring each finding.";
    const nextPrompt = event.systemPrompt.includes(line) ? event.systemPrompt : `${event.systemPrompt}\n\n${line}`;
    return nextPrompt === event.systemPrompt ? undefined : { systemPrompt: nextPrompt };
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.();
    const fresh = runtimeSessionId !== sessionId;
    runtimeSessionId = sessionId;
    if (runtime && !fresh) return; // same session — already initialized
    const config = await loadConfig(ctx);
    let models = config.models;
    if (models.length === 0 && !migrationAttempted) {
      // One-shot per process: never re-arm after the user disables the advisor.
      migrationAttempted = true;
      const legacy = await migrateLegacyAdvisorModel();
      if (legacy) {
        models = [legacy];
        ctx.ui.notify(`Advisor model migrated from pi-plan: ${legacy}`, "info");
        // If we migrated on top of a pi-plan that had legacyMigrated:true already,
        // the user config may still lack migrationVersion. Backfill it idempotently
        // so no future manual patch is needed (code writes, agent never touches
        // the real global config directly).
      }
    }
    runtime = createRuntime(config, models);
    watchEnabled = config.watch.enabled;
    // Watch is gated on both enabled and a configured chain — no self-review.
    if (!watchEnabled || models.length === 0) return;
    // Seed the cursor to the current transcript tail so the first review
    // covers only work that happens after the advisor was loaded.
    const entries = ctx.sessionManager.getEntries() as any[];
    runtime.cursor = entries.length ? entries[entries.length - 1].id : undefined;
  });

  // Self-disarm on session teardown: session_shutdown is emitted and awaited
  // BEFORE the runner invalidates (agent-session-runtime teardownCurrent), so
  // flipping the flag here makes live() false in this (about-to-be-orphaned)
  // closure — an in-flight fire-and-forget review is discarded silently
  // instead of throwing the stale-ctx error into the .catch and toasting the
  // NEW session. The factory re-runs per session, so this never touches a
  // live session's flag.
  pi.on("session_shutdown", () => { watchEnabled = false; });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!runtime || !watchEnabled || runtime.stats.paused) return;
    // Only TUI: a floating review would die at process exit in headless
    // modes, and a note there fired an unrequested follow-up run. Fail-safe:
    // unknown/mode-less contexts skip too (missed review < surprise run).
    if (ctx.mode !== "tui") return;
    // ponytail: fire-and-forget — pi core awaits agent_settled handlers before
    // the TUI regains input, so awaiting the 10-90s+ review here froze the UI
    // after every turn. Notes deliver via sendUserMessage, which the SDK
    // queues as a steer when a run is active or fires as a follow-up turn
    // when idle. A still-running review makes the next settle skip (rt
    // reviewing flag) — bounded loss, not queued.
    const rt = runtime;
    // Liveness guard evaluated at delivery time (not just settle time): a
    // fresh session (/new) replaces runtime, /advisor off clears the chain,
    // watch-off flips the flag, repeated failures pause — a review in flight
    // across any of these must deliver nothing.
    const live = () => runtime === rt && watchEnabled && rt.models.length > 0 && !rt.stats.paused;
    void reviewTurn(rt, ctx, {
      sendMessage: (message, options) => { if (live()) pi.sendMessage(message, options as never); },
      sendUserMessage: (content, options) => { if (live()) pi.sendUserMessage(content, options); },
      appendEntry: (customType, data) => { if (live()) pi.appendEntry(customType, data); },
      notify: (message) => { if (live()) ctx.ui.notify(message, "error"); },
    }, testIsolated).catch((err) => { if (live()) ctx.ui.notify(`Advisor review failed: ${String(err)}`, "error"); });
  });

  registerAdvisor(pi, {
    getModels: () => runtime?.models ?? [],
    setModels: async (models) => {
      await saveModels(models);
      if (runtime) runtime.models = models;
    },
    getThinking: () => undefined,
    getRuntime: () => runtime,
    isWatchEnabled: () => watchEnabled,
    setWatchEnabled: (value) => {
      watchEnabled = value;
      if (value && runtime) migrationAttempted = true; // belt-and-suspenders on top of the persisted tombstone
    },
    onEnableWatch: (ctx) => {
      // Reseed so enabling mid-session reviews only future work.
      if (runtime) reseedCursor(runtime, ctx);
    },
  });
}
