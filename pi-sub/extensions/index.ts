import { readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATUS_KEY = "pi-sub";
const MESSAGE_TYPE = "pi-sub-status";
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_INTERVAL_MS = 60_000;
const REFRESH_TTL_MS = 30_000;
const REFRESH_DEBOUNCE_MS = 2_000;
const CODEX_PROVIDER = "openai-codex";
const OPC_PROVIDER = "opencode-go";
const ZAI_PROVIDER = "zai";
const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_CODING_CN_PROVIDER = "zai-coding-cn";
const ZAI_CODING_CN_USAGE_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const ROUTER_PROVIDER = "router";
const LEGACY_9ROUTER_PROVIDER = "9router";
// pi-router (formerly pi-9router): URL lives in settings.json `router.baseUrl`
// (env override ROUTER_BASE_URL), key in auth.json `router` credential.
const ROUTER_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const COMMAND_CODE_PROVIDER = "commandcode";
const COMMAND_CODE_USAGE_URL = "https://api.commandcode.ai/alpha/billing/credits";

type ModelLike = { provider?: string; id?: string } | undefined;

type UsageApiWindow = {
  used_percent?: number;
  reset_at?: number;
};

type UsageApiSnapshot = {
  primary?: UsageApiWindow;
  secondary?: UsageApiWindow;
  plan_type?: string;
};

type PiAuthEntry = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  key?: string;
  email?: string;
  label?: string;
  name?: string;
  env?: Record<string, string>;
};

interface UsageWindow {
  percent?: number;
  remaining?: number;
  remainingLabel?: string;
  resetLabel?: string;
}

interface SubscriptionAccountSnapshot {
  id?: string;
  isActive?: boolean;
  accountLabel?: string;
  plan?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  // Command Code-only: monthly credit balance in USD (not a rolling window).
  monthlyCredits?: number;
  // Z.ai-only extras surfaced in the /sub detail view.
  mcpMonthly?: UsageWindow; // from TIME_LIMIT already present in the quota response
  usageBreakdown?: string; // per-model / per-tool summary line(s)
  lastActivity?: string;
}

interface SubscriptionUsageSnapshot {
  providerDisplayName: string;
  accounts: SubscriptionAccountSnapshot[];
  activeAccount?: SubscriptionAccountSnapshot;
  fetchedAt: number;
  error?: string;
}

type SubscriptionProviderAdapter = {
  id: string;
  displayName: string;
  fetchUsage(signal?: AbortSignal): Promise<SubscriptionUsageSnapshot>;
};

interface State {
  model?: ModelLike;
  adapter?: SubscriptionProviderAdapter;
  adapterId?: string;
  snapshot?: SubscriptionUsageSnapshot;
  lastRefreshAt: number;
  refreshGeneration: number;
  inFlight?: Promise<SubscriptionUsageSnapshot>;
  refreshTimer?: NodeJS.Timeout;
  debounceTimer?: NodeJS.Timeout;
  responseStartTime?: number;
  lastTokPerSec?: number;
  cumulativeOutput: number;
  cumulativeDurationMs: number;
  cumulativeCost: number;
}

function isCodexModel(model: ModelLike): boolean {
  const provider = model?.provider?.toLowerCase() ?? "";
  return provider === CODEX_PROVIDER || provider.includes(CODEX_PROVIDER);
}

function isOpenCodeGoModel(model: ModelLike): boolean {
  return (model?.provider?.toLowerCase() ?? "") === OPC_PROVIDER;
}

function isZaiModel(model: ModelLike): boolean {
  return (model?.provider?.toLowerCase() ?? "") === ZAI_PROVIDER;
}

function isZaiCodingCnModel(model: ModelLike): boolean {
  return (model?.provider?.toLowerCase() ?? "") === ZAI_CODING_CN_PROVIDER;
}

function isRouterModel(model: ModelLike, provider: string = ROUTER_PROVIDER): boolean {
  return (model?.provider?.toLowerCase() ?? "") === provider;
}

function isCommandCodeModel(model: ModelLike): boolean {
  return (model?.provider?.toLowerCase() ?? "") === COMMAND_CODE_PROVIDER;
}

function piAuthPath(): string {
  const configDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(configDir, "auth.json");
}

function decodeJwtPayload(token: string | undefined): Record<string, any> | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function accountFromPiAuth(entry: PiAuthEntry): SubscriptionAccountSnapshot {
  const claims = decodeJwtPayload(entry.access);
  const profile = claims?.["https://api.openai.com/profile"];
  const auth = claims?.["https://api.openai.com/auth"];
  const email = typeof profile?.email === "string" ? profile.email : undefined;
  const plan = typeof auth?.chatgpt_plan_type === "string" ? planLabel(auth.chatgpt_plan_type) : undefined;
  const accountId = typeof entry.accountId === "string" ? entry.accountId : typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  return {
    id: accountId,
    isActive: true,
    accountLabel: email ?? accountId ?? "openai-codex account",
    plan,
    lastActivity: "Now",
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function authEntryLabel(entry: PiAuthEntry | undefined): string | undefined {
  return firstString(entry?.email, entry?.label, entry?.name, entry?.accountId);
}

function keyFingerprint(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function authAccountLabel(providerLabel: string, entry: PiAuthEntry | undefined): string {
  const label = authEntryLabel(entry);
  if (label) return label;
  const fingerprint = keyFingerprint(entry?.key);
  return fingerprint ? `${providerLabel} key#${fingerprint}` : `${providerLabel} account`;
}

function authAccountSnapshot(providerLabel: string, entry: PiAuthEntry | undefined, defaults: Partial<SubscriptionAccountSnapshot> = {}): SubscriptionAccountSnapshot {
  return {
    id: firstString(entry?.accountId),
    isActive: true,
    accountLabel: authAccountLabel(providerLabel, entry),
    lastActivity: "Now",
    ...defaults,
  };
}

function formatFooterAccount(account: SubscriptionAccountSnapshot | undefined): string | undefined {
  const label = firstString(account?.accountLabel);
  return label ? `(${label})` : undefined;
}

function getCodexAccountId(entry: PiAuthEntry | undefined): string | undefined {
  if (!entry) return undefined;
  if (typeof entry.accountId === "string" && entry.accountId.length > 0) return entry.accountId;
  const claims = decodeJwtPayload(entry.access);
  const auth = claims?.["https://api.openai.com/auth"];
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function planLabel(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  const normalized = plan.toLowerCase().replace(/[_-]+/g, " ");
  const labels: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    prolite: "Pro Lite",
    "pro lite": "Pro Lite",
    pro: "Pro",
    team: "Business",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    unknown: "Unknown",
  };
  return labels[normalized] ?? plan;
}

function formatRemainingTime(resetAtSec: number | undefined): string | undefined {
  if (!resetAtSec) return undefined;
  const nowSec = Date.now() / 1000;
  const remainingSec = resetAtSec - nowSec;
  if (remainingSec <= 0) return "0M";
  const remainingMin = Math.ceil(remainingSec / 60);
  if (remainingMin < 60) return `${remainingMin}M`;
  const remainingH = Math.ceil(remainingSec / 3600);
  if (remainingH < 24) return `${remainingH}H`;
  const remainingD = Math.ceil(remainingSec / 86400);
  return `${remainingD}D`;
}

function formatReset(timestampSeconds: number | undefined): string | undefined {
  if (!timestampSeconds) return undefined;
  const date = new Date(timestampSeconds * 1000);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString(undefined, { day: "numeric" });
  const month = date.toLocaleDateString(undefined, { month: "short" });
  return `${time} on ${day} ${month}`;
}

function usageWindowFromApi(window: UsageApiWindow | undefined): UsageWindow | undefined {
  if (!window || typeof window.used_percent !== "number") return undefined;
  const percent = Math.round(window.used_percent);
  const remaining = Math.max(0, 100 - percent);
  const resetLabel = formatReset(window.reset_at);
  const remainingLabel = formatRemainingTime(window.reset_at);
  return {
    percent,
    remaining,
    remainingLabel,
    resetLabel,
  };
}

function mergeUsageIntoAccount(account: SubscriptionAccountSnapshot, usage: UsageApiSnapshot | undefined): SubscriptionAccountSnapshot {
  if (!usage) return account;
  return {
    ...account,
    plan: planLabel(usage.plan_type) ?? account.plan,
    fiveHour: usageWindowFromApi(usage.primary) ?? account.fiveHour,
    weekly: usageWindowFromApi(usage.secondary) ?? account.weekly,
  };
}

function parseUsageResponse(body: unknown): UsageApiSnapshot | undefined {
  if (!body || typeof body !== "object") return undefined;
  const root = body as any;
  const rateLimit = root.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return undefined;
  const parseWindow = (window: any): UsageApiWindow | undefined => {
    if (!window || typeof window !== "object" || typeof window.used_percent !== "number") return undefined;
    return {
      used_percent: window.used_percent,
      reset_at: typeof window.reset_at === "number" ? window.reset_at : undefined,
    };
  };
  return {
    primary: parseWindow(rateLimit.primary_window),
    secondary: parseWindow(rateLimit.secondary_window),
    plan_type: typeof root.plan_type === "string" ? root.plan_type : undefined,
  };
}

async function readPiCodexAuth(): Promise<PiAuthEntry & { accountId: string }> {
  const entry = readStoredCredential(CODEX_PROVIDER, piAuthPath()) as PiAuthEntry | undefined;
  const accountId = getCodexAccountId(entry);
  if (!entry?.access || !accountId) throw new Error("Missing openai-codex OAuth entry in Pi auth");
  return { ...entry, accountId };
}

async function readOpenCodeGoAuth(): Promise<SubscriptionAccountSnapshot> {
  const entry = readStoredCredential(OPC_PROVIDER, piAuthPath()) as PiAuthEntry | undefined;
  if (!entry?.key && !entry?.accountId) throw new Error("Missing opencode-go API key or accountId in Pi auth");
  return authAccountSnapshot("OpenCode Go", entry, { plan: "Go" });
}

async function readZaiAuth(providerId: string, label: string): Promise<{ key: string; account: SubscriptionAccountSnapshot }> {
  const entry = readStoredCredential(providerId, piAuthPath()) as PiAuthEntry | undefined;
  if (!entry?.key) throw new Error(`Missing ${providerId} API key in Pi auth`);
  return { key: entry.key, account: authAccountSnapshot(label, entry) };
}

// ponytail: duplicated from pi-router — no shared config lib, ~12 lines, acceptable
function readRouterConfig(): { baseUrl: string } | null {
  try {
    let baseUrl = process.env.ROUTER_BASE_URL || process.env.NINE_ROUTER_BASE_URL;
    if (!baseUrl && fs.statSync(ROUTER_SETTINGS_PATH).isFile()) {
      const settings = JSON.parse(fs.readFileSync(ROUTER_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
      const router = settings.router as { baseUrl?: unknown } | undefined;
      if (typeof router?.baseUrl === "string" && router.baseUrl) baseUrl = router.baseUrl;
    }
    return baseUrl ? { baseUrl } : null;
  } catch {
    return null;
  }
}

/** Router API key: auth.json `router` credential (via /login), then env. */
function readRouterApiKey(): string | undefined {
  const stored = readStoredCredential(ROUTER_PROVIDER, piAuthPath()) as PiAuthEntry | undefined;
  if (stored?.key) return stored.key;
  return process.env.ROUTER_API_KEY || process.env.NINE_ROUTER_API_KEY || undefined;
}

/** Strip a `/v1` suffix so management routes (under the origin) can be
 *  derived from the OpenAI-compatible baseUrl. */
function routerOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/** Parse OmniRoute's `/api/usage/om-usage` plain-text report into windows.
 *  Sections: "Personal quota" (per-key USD budgets: Daily/Weekly) and
 *  "Provider quota" (connection session/weekly). Lines: `<Label>`,
 *  `NN% left`, `⏱ reset in <countdown>`. Robust to missing/unknown blocks. */
export function parseOmniUsageText(text: string): {
  personalDaily?: UsageWindow;
  personalWeekly?: UsageWindow;
  session?: UsageWindow;
  providerWeekly?: UsageWindow;
} {
  const out: {
    personalDaily?: UsageWindow;
    personalWeekly?: UsageWindow;
    session?: UsageWindow;
    providerWeekly?: UsageWindow;
  } = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let inPersonal = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase() === "personal quota") { inPersonal = true; continue; }
    if (line.toLowerCase() === "provider quota") { inPersonal = false; continue; }
    const usedMatch = line.match(/^(\d+)%\s*left$/);
    if (!usedMatch) continue;
    const label = (lines[i - 1] ?? "").toLowerCase();
    const resetMatch = lines[i + 1]?.match(/reset in (.+)$/);
    const remaining = Number(usedMatch[1]);
    if (remaining < 0 || remaining > 100) continue;
    const window: UsageWindow = { remaining };
    if (resetMatch) window.resetLabel = `⏱ ${resetMatch[1].trim()}`;
    if (inPersonal) {
      if (label.includes("daily")) out.personalDaily = window;
      else if (label.includes("weekly")) out.personalWeekly = window;
    } else {
      if (label.includes("session")) out.session = window;
      else if (label.includes("weekly")) out.providerWeekly = window;
    }
  }
  return out;
}

// ponytail: runnable self-check (pi-sub has no test runner — pack gate only)
if (process.env.PI_SUB_SELF_CHECK === "1") {
  const sample = [
    "Personal quota", "Daily", "80% left", "⏱ reset in 15h 0m", "",
    "Weekly", "90% left", "⏱ reset in 7d 0h 0m", "",
    "Provider quota", "Session", "47% left", "⏱ reset in 9m", "",
    "Weekly", "28% left", "⏱ reset in 1d 0h 0m",
  ].join("\n");
  const p = parseOmniUsageText(sample);
  const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error("pi-sub self-check: " + msg); };
  assert(p.personalDaily?.remaining === 80, "personal daily 80");
  assert(p.personalWeekly?.remaining === 90, "personal weekly 90");
  assert(p.session?.remaining === 47, "session 47");
  assert(p.providerWeekly?.remaining === 28, "provider weekly 28");
  assert(p.personalDaily?.resetLabel?.includes("15h"), "daily reset label");
  const disabled = parseOmniUsageText("Usage command is disabled for this API key.");
  assert(Object.keys(disabled).length === 0, "disabled text parses empty");
}

async function fetchUsageFromPiAuth(entry: PiAuthEntry, signal?: AbortSignal): Promise<UsageApiSnapshot | undefined> {
  const accountId = getCodexAccountId(entry) ?? entry.accountId;
  if (!accountId) throw new Error("Missing openai-codex OAuth entry in Pi auth");
  const timeoutSignal = AbortSignal.timeout(7_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(USAGE_ENDPOINT, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${entry.access}`,
      "ChatGPT-Account-Id": accountId,
      "User-Agent": "pi-sub/0.1.0",
    },
    signal: combinedSignal,
  });
  if (!response.ok) throw new Error(`usage request failed with HTTP ${response.status}`);
  return parseUsageResponse(await response.json());
}

function redactedError(error: unknown, provider = "Codex"): string {
  const message = error instanceof Error ? error.message : String(error || "Unknown error");
  if (/ENOENT|no such file/i.test(message)) return "Pi auth not found";
  if (/missing openai-codex/i.test(message)) return "openai-codex auth not found";
  if (/missing opencode-go/i.test(message)) return "opencode-go auth not found";
  if (/missing zai/i.test(message)) return "zai auth not found";
  if (/missing commandcode/i.test(message)) return "commandcode auth not found";
  if (/timed out|timeout|aborted/i.test(message)) return `${provider} usage refresh timed out`;
  if (/401|403|auth|token|unauthorized|forbidden/i.test(message)) return `${provider} auth unavailable`;
  return `${provider} usage unavailable`;
}

async function fetchCodexUsage(signal?: AbortSignal): Promise<SubscriptionUsageSnapshot> {
  try {
    const entry = await readPiCodexAuth();
    let activeAccount = accountFromPiAuth(entry);
    const usage = await fetchUsageFromPiAuth(entry, signal);
    activeAccount = mergeUsageIntoAccount(activeAccount, usage);
    return {
      providerDisplayName: "Codex",
      accounts: [activeAccount],
      activeAccount,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    return {
      providerDisplayName: "Codex",
      accounts: [],
      fetchedAt: Date.now(),
      error: redactedError(error),
    };
  }
}

async function fetchOpenCodeGoUsage(_signal?: AbortSignal): Promise<SubscriptionUsageSnapshot> {
  try {
    const account = await readOpenCodeGoAuth();
    return {
      providerDisplayName: "OpenCode Go",
      accounts: [account],
      activeAccount: account,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    return {
      providerDisplayName: "OpenCode Go",
      accounts: [],
      fetchedAt: Date.now(),
      error: redactedError(error, "OpenCode Go"),
    };
  }
}

async function fetchRouterUsage(signal?: AbortSignal): Promise<SubscriptionUsageSnapshot> {
  const cfg = readRouterConfig();
  const now = Date.now();
  if (!cfg) {
    return {
      providerDisplayName: "Router",
      accounts: [],
      fetchedAt: now,
      error: "router not configured — set router.baseUrl in ~/.pi/agent/settings.json",
    };
  }
  const apiKey = readRouterApiKey();
  const baseAccount: SubscriptionAccountSnapshot = {
    id: cfg.baseUrl,
    isActive: true,
    accountLabel: cfg.baseUrl.replace(/^https?:\/\//, ""),
    lastActivity: "Now",
  };

  // OmniRoute exposes per-key usage at GET <origin>/api/usage/om-usage
  // (Bearer = the router API key). The report is plain text: Personal quota
  // (Daily/Weekly USB budgets) + Provider quota (Session/Weekly connections).
  // Non-OmniRoute routers 404 here — fall back to endpoint-only display.
  if (apiKey) {
    try {
      const timeoutSignal = AbortSignal.timeout(7_000);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(`${routerOrigin(cfg.baseUrl)}/api/usage/om-usage`, {
        headers: { Accept: "text/plain", Authorization: `Bearer ${apiKey}` },
        signal: combined,
      });
      if (response.ok) {
        const text = await response.text();
        if (text && !text.includes("disabled")) {
          const w = parseOmniUsageText(text);
          // personalDaily = per-key budget (nearest reset → R slot),
          // provider weekly = connection quota (W slot). Fall back sensibly.
          const account: SubscriptionAccountSnapshot = {
            ...baseAccount,
            plan: "Router usage",
            fiveHour: w.personalDaily ?? w.session,
            weekly: w.providerWeekly ?? w.personalWeekly,
            usageBreakdown: text.length > 120 ? text : undefined,
          };
          return {
            providerDisplayName: "Router",
            accounts: [account],
            activeAccount: account,
            fetchedAt: Date.now(),
          };
        }
        // Usage command exists but is disabled for this key — keep the footer
        // clean (endpoint display) and surface the hint in /sub detail only.
        const hintAccount: SubscriptionAccountSnapshot = {
          ...baseAccount,
          usageBreakdown: "OmniRoute usage command is disabled for this API key — " +
            "enable it in the dashboard (API Keys → this key → usage command).",
        };
        return {
          providerDisplayName: "Router",
          accounts: [hintAccount],
          activeAccount: hintAccount,
          fetchedAt: Date.now(),
        };
      }
    } catch { /* non-OmniRoute or transient — fall through to endpoint display */ }
  }

  return {
    providerDisplayName: "Router",
    accounts: [baseAccount],
    activeAccount: baseAccount,
    fetchedAt: now,
  };
}

// Command Code's /alpha/billing/credits endpoint (auth: same Provider API key
// as /provider/v1 models) returns live 5-hour and weekly rolling windows plus
// the monthly credit balance — the same data as the cmd /usage CLI.
async function fetchCommandCodeUsage(signal?: AbortSignal): Promise<SubscriptionUsageSnapshot> {
  try {
    const { key: apiKey, account: authAccount } = await readZaiAuth(COMMAND_CODE_PROVIDER, "Command Code");
    const timeoutSignal = AbortSignal.timeout(7_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "pi-sub/0.1.27",
    };
    const response = await fetch(COMMAND_CODE_USAGE_URL, { headers, signal: combinedSignal });
    if (!response.ok) {
      throw new Error(`Command Code usage request failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as CommandCodeCreditsApiResponse;

    const credits = body.credits;
    const windowLimits = body.windowLimits;
    const fiveHour = commandCodeWindowToUsageWindow(windowLimits?.fiveHour);
    const weekly = commandCodeWindowToUsageWindow(windowLimits?.weekly);

    // Monthly allowance is an absolute USD balance, not a rolling window.
    const monthlyCredits = typeof credits?.monthlyCredits === "number" ? credits.monthlyCredits : undefined;
    const monthlyLine = monthlyCredits !== undefined ? `Monthly: $${monthlyCredits.toFixed(2)} remaining` : undefined;
    const breakdown = [monthlyLine].filter((s): s is string => !!s);

    const account: SubscriptionAccountSnapshot = {
      ...authAccount,
      fiveHour,
      weekly,
      monthlyCredits,
      usageBreakdown: breakdown.length > 0 ? breakdown.join("\n") : undefined,
    };

    return {
      providerDisplayName: "Command Code",
      accounts: [account],
      activeAccount: account,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    return {
      providerDisplayName: "Command Code",
      accounts: [],
      fetchedAt: Date.now(),
      error: redactedError(error, "Command Code"),
    };
  }
}

// ---------------------------------------------------------------------------
// Z.ai adapter
// ---------------------------------------------------------------------------

interface ZaiLimitEntry {
  type: string;
  percentage: number;
  nextResetTime?: number;
}

interface ZaiUsageApiResponse {
  data?: {
    limits?: ZaiLimitEntry[];
    planName?: string;
    plan?: string;
    plan_type?: string;
    packageName?: string;
    level?: string;
  };
}

interface ZaiUsageApiError {
  code: number;
  msg: string;
  success?: boolean;
}

// ---------------------------------------------------------------------------
// Command Code adapter
// ---------------------------------------------------------------------------
// Live-verified 2026-08-09: GET https://api.commandcode.ai/alpha/billing/credits
// with the Provider API key (same user_... key as /provider/v1 models) returns
// USD windows + monthly credit balance. resetAt is epoch milliseconds.

interface CommandCodeWindowApi {
  used: number;
  cap: number;
  exceeded?: boolean | null;
  resetAt?: number;
}

interface CommandCodeCreditsApiResponse {
  credits?: {
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
    belowThreshold?: boolean;
  };
  windowLimits?: {
    limited?: boolean;
    fiveHour?: CommandCodeWindowApi;
    weekly?: CommandCodeWindowApi;
  };
}

/** Map a Command Code USD window (used/cap in dollars, resetAt in ms) into
 *  the shared UsageWindow shape (remaining%, reset labels). */
function commandCodeWindowToUsageWindow(window: CommandCodeWindowApi | undefined): UsageWindow | undefined {
  if (!window || typeof window.used !== "number" || typeof window.cap !== "number" || window.cap <= 0) return undefined;
  const usedPct = Math.round((window.used / window.cap) * 100);
  const percent = Math.min(100, usedPct);
  const remaining = Math.max(0, 100 - percent);
  // resetAt is epoch ms; format helpers expect seconds.
  const resetAtSec = window.resetAt ? window.resetAt / 1000 : undefined;
  const resetLabel = formatReset(resetAtSec);
  const remainingLabel = formatRemainingTime(resetAtSec);
  return { percent, remaining, remainingLabel, resetLabel };
}

function zaiLimitToUsageWindow(limit: ZaiLimitEntry): UsageWindow | undefined {
  if (typeof limit.percentage !== "number") return undefined;
  const percent = Math.round(limit.percentage);
  const remaining = Math.max(0, 100 - percent);
  // Z.ai returns nextResetTime in epoch milliseconds; format helpers expect seconds.
  const resetAtSec = limit.nextResetTime ? limit.nextResetTime / 1000 : undefined;
  const resetLabel = formatReset(resetAtSec);
  const remainingLabel = formatRemainingTime(resetAtSec);
  return {
    percent,
    remaining,
    remainingLabel,
    resetLabel,
  };
}

function zaiPlanLabel(response: ZaiUsageApiResponse): string | undefined {
  const data = response.data;
  return planLabel(firstString(data?.planName, data?.plan, data?.plan_type, data?.packageName, data?.level));
}

function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

// ponytail: trailing-24h window matches Z.ai dashboard intent (chelper uses ~48h).
function zaiUsageTimeWindow(): string {
  const fmt = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const now = new Date();
  return `?startTime=${encodeURIComponent(fmt(new Date(now.getTime() - 86_400_000)))}&endTime=${encodeURIComponent(fmt(now))}`;
}

// Z.ai model-usage / tool-usage are time-series responses (verified live, CN host).
// Per-model totals live in data.totalUsage.modelSummaryList[]; tool totals are
// named scalars in data.totalUsage. Return undefined on any mismatch so the
// quota table is never affected.
function parseZaiModelUsage(body: unknown): string | undefined {
  const tu = (body as any)?.data?.totalUsage;
  const list = tu?.modelSummaryList;
  if (!Array.isArray(list)) return undefined;
  const entries = list
    .map((m: any) => ({ name: m?.modelName, count: m?.totalTokens }))
    .filter((e: { name: string; count: number }) => typeof e.name === "string" && e.name && typeof e.count === "number" && e.count > 0)
    .sort((a, b) => b.count - a.count);
  if (entries.length === 0) return undefined;
  const calls = typeof tu.totalModelCallCount === "number" && tu.totalModelCallCount > 0 ? ` (${tu.totalModelCallCount} calls)` : "";
  return `Models: ${entries.map((e) => `${e.name} ${compactCount(e.count)}`).join(" · ")}${calls}`;
}

function parseZaiToolUsage(body: unknown): string | undefined {
  const u = (body as any)?.data?.totalUsage;
  if (!u || typeof u !== "object") return undefined;
  // ponytail: fixed label map — Z.ai returns named scalar counts, not a list.
  const labels: Record<string, string> = {
    totalNetworkSearchCount: "search",
    totalWebReadMcpCount: "web-read",
    totalZreadMcpCount: "zread",
    totalSearchMcpCount: "search-mcp",
  };
  const entries = Object.entries(labels)
    .map(([field, label]) => ({ label, count: u[field] }))
    .filter((e: { label: string; count: number }) => typeof e.count === "number" && e.count > 0);
  if (entries.length === 0) return undefined;
  return `Tools: ${entries.map((e) => `${e.label} ${e.count}`).join(" · ")}`;
}

// Factory: the international `zai` and China `zai-coding-cn` endpoints share an
// identical quota response; only the provider id, host, and label differ.
function zaiUsageAdapter(providerId: string, usageUrl: string, displayName: string): { fetchUsage(signal?: AbortSignal): Promise<SubscriptionUsageSnapshot> } {
  async function fetchUsage(signal?: AbortSignal): Promise<SubscriptionUsageSnapshot> {
    try {
      const { key: apiKey, account: authAccount } = await readZaiAuth(providerId, displayName);
      const timeoutSignal = AbortSignal.timeout(7_000);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "pi-sub/0.1.0",
      };
      const response = await fetch(usageUrl, { headers, signal: combinedSignal });

      const body = await response.json();

      // Z.ai / BigModel return HTTP 200 even on auth errors: {"code":401,"msg":"...","success":false}
      // Also handle missing success field, empty msg, or presence of code.
      const apiError = body as ZaiUsageApiError;
      if (apiError.code >= 400 || (typeof apiError.success === "boolean" && !apiError.success) || (apiError.msg && apiError.msg.length > 0 && apiError.success === undefined)) {
        const message = apiError.msg || `HTTP status ${apiError.code}`;
        throw new Error(`${displayName} API error: ${message}`);
      }

      const parsed = body as ZaiUsageApiResponse;
      const limits = parsed.data?.limits ?? [];
      const tokenLimits = limits
        .filter((l) => l.type === "TOKENS_LIMIT")
        .sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0));
      // TIME_LIMIT is the MCP/month allowance already present in this response.
      const timeLimit = limits.find((l) => l.type === "TIME_LIMIT");

      if (tokenLimits.length === 0) {
        throw new Error(`No TOKENS_LIMIT entries in ${displayName} usage response`);
      }

      // The limit with the nearest reset is the 5-hour rolling window;
      // the next one (if present) is the weekly window.
      const fiveHour = zaiLimitToUsageWindow(tokenLimits[0]);
      const weekly = tokenLimits.length >= 2 ? zaiLimitToUsageWindow(tokenLimits[1]) : undefined;
      const mcpMonthly = timeLimit ? zaiLimitToUsageWindow(timeLimit) : undefined;

      // Best-effort: per-model tokens + per-tool calls. Any failure is silent; the
      // quota table above is the source of truth and never depends on these.
      const window = zaiUsageTimeWindow();
      const modelUrl = usageUrl.replace(/\/quota\/limit$/, "/model-usage") + window;
      const toolUrl = usageUrl.replace(/\/quota\/limit$/, "/tool-usage") + window;
      const [modelRes, toolRes] = await Promise.allSettled([
        fetch(modelUrl, { headers, signal: combinedSignal }).then((r) => r.json()),
        fetch(toolUrl, { headers, signal: combinedSignal }).then((r) => r.json()),
      ]);
      const breakdowns = [
        modelRes.status === "fulfilled" ? parseZaiModelUsage(modelRes.value) : undefined,
        toolRes.status === "fulfilled" ? parseZaiToolUsage(toolRes.value) : undefined,
      ].filter((s): s is string => !!s);

      const account: SubscriptionAccountSnapshot = {
        ...authAccount,
        plan: zaiPlanLabel(parsed) ?? authAccount.plan,
        fiveHour,
        weekly,
        mcpMonthly,
        usageBreakdown: breakdowns.length > 0 ? breakdowns.join("\n") : undefined,
      };

      return {
        providerDisplayName: displayName,
        accounts: [account],
        activeAccount: account,
        fetchedAt: Date.now(),
      };
    } catch (error) {
      return {
        providerDisplayName: displayName,
        accounts: [],
        fetchedAt: Date.now(),
        error: redactedError(error, displayName),
      };
    }
  }
  return { fetchUsage };
}

function supportedAdapter(model: ModelLike): SubscriptionProviderAdapter | undefined {
  if (isCodexModel(model)) return { id: CODEX_PROVIDER, displayName: "Codex", fetchUsage: fetchCodexUsage };
  if (isOpenCodeGoModel(model)) return { id: OPC_PROVIDER, displayName: "OpenCode Go", fetchUsage: fetchOpenCodeGoUsage };
  if (isZaiModel(model)) return { id: ZAI_PROVIDER, displayName: "Z.ai", ...zaiUsageAdapter(ZAI_PROVIDER, ZAI_USAGE_URL, "Z.ai") };
  if (isZaiCodingCnModel(model)) return { id: ZAI_CODING_CN_PROVIDER, displayName: "Z.ai (CN)", ...zaiUsageAdapter(ZAI_CODING_CN_PROVIDER, ZAI_CODING_CN_USAGE_URL, "Z.ai (CN)") };
  if (isRouterModel(model)) return { id: ROUTER_PROVIDER, displayName: "Router", fetchUsage: fetchRouterUsage };
  if (isRouterModel(model, LEGACY_9ROUTER_PROVIDER)) return { id: LEGACY_9ROUTER_PROVIDER, displayName: "9router (legacy)", fetchUsage: fetchRouterUsage };
  if (isCommandCodeModel(model)) return { id: COMMAND_CODE_PROVIDER, displayName: "Command Code", fetchUsage: fetchCommandCodeUsage };
  return undefined;
}

function formatRemaining(window: UsageWindow | undefined): string {
  if (!window) return "?";
  if (window.remainingLabel) return `${window.remaining}%/${window.remainingLabel}`;
  if (window.remaining !== undefined) return `${window.remaining}%`;
  return "?";
}

function minRemaining(account: SubscriptionAccountSnapshot | undefined): number {
  const values: number[] = [];
  if (account?.fiveHour?.remaining !== undefined) values.push(account.fiveHour.remaining);
  if (account?.weekly?.remaining !== undefined) values.push(account.weekly.remaining);
  if (values.length === 0) return 100;
  return Math.min(...values);
}

function windowSegments(account: SubscriptionAccountSnapshot | undefined): string[] {
  if (!account) return [];
  const segments: string[] = [];
  if (account.fiveHour) segments.push(`R:${formatRemaining(account.fiveHour)}`);
  if (account.weekly) segments.push(`W:${formatRemaining(account.weekly)}`);
  return segments;
}

function renderSubscriptionLine(ctx: ExtensionContext, state: State): void {
  const theme = ctx.ui.theme;
  if (!state.adapter) {
    // Unsupported provider (e.g. Ollama): still show the last response speed.
    ctx.ui.setStatus(STATUS_KEY, state.lastTokPerSec !== undefined ? theme.fg("dim", `${state.lastTokPerSec} tok/s`) : undefined);
    return;
  }
  const snapshot = state.snapshot;
  let line: string;
  let color: "dim" | "warning" | "error" = "dim";
  if (!snapshot) {
    line = `Sub ${state.adapter.displayName} loading`;
  } else if (snapshot.error) {
    line = `Sub ${snapshot.error}`;
    color = "warning";
  } else {
    const account = snapshot.activeAccount;
    const windowParts = windowSegments(account);
    const accountPart = formatFooterAccount(account);
    const segments = accountPart ? [accountPart, ...windowParts] : [...windowParts];
    const cost = state.cumulativeCost;
    const hasWindows = windowParts.length > 0;
    // Command Code monthly balance: compact USD figure, e.g. M:$69.99.
    if (typeof account?.monthlyCredits === "number") segments.push(`M:$${account.monthlyCredits.toFixed(2)}`);
    if (cost > 0) segments.push(`$${cost.toFixed(2)}`);
    if (state.lastTokPerSec !== undefined) segments.push(`${state.lastTokPerSec} tok/s`);
    if (segments.length === 0) {
      line = `Sub ${state.adapter.displayName}`;
    } else if (!hasWindows) {
      line = `${state.adapter.displayName} ${segments.join(" ")}`;
    } else {
      line = segments.join(" ");
    }
    const remaining = minRemaining(account);
    color = remaining <= 10 ? "error" : remaining <= 20 ? "warning" : "dim";
  }
  ctx.ui.setStatus(STATUS_KEY, theme.fg(color, line));
}

function startTimer(ctx: ExtensionContext, state: State): void {
  if (state.refreshTimer || !state.adapter) return;
  state.refreshTimer = setInterval(() => {
    void refreshUsage(ctx, state, false);
  }, REFRESH_INTERVAL_MS);
}

function stopTimer(state: State): void {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.refreshTimer = undefined;
  state.debounceTimer = undefined;
}

function updateActiveAdapter(ctx: ExtensionContext, state: State, model: ModelLike): void {
  const nextAdapter = supportedAdapter(model);
  const adapterChanged = state.adapterId !== nextAdapter?.id;

  state.model = model;
  state.adapter = nextAdapter;
  state.adapterId = nextAdapter?.id;

  if (adapterChanged) {
    state.snapshot = undefined;
    state.lastRefreshAt = 0;
    state.inFlight = undefined;
    state.refreshGeneration++;
  }

  if (!state.adapter) {
    stopTimer(state);
  }
  renderSubscriptionLine(ctx, state);
  if (state.adapter) startTimer(ctx, state);
}

async function refreshUsage(ctx: ExtensionContext, state: State, force: boolean): Promise<SubscriptionUsageSnapshot | undefined> {
  const adapter = state.adapter;
  if (!adapter) {
    renderSubscriptionLine(ctx, state);
    return undefined;
  }
  if (!force && state.snapshot && Date.now() - state.lastRefreshAt < REFRESH_TTL_MS) return state.snapshot;
  if (state.inFlight) return state.inFlight;
  const generation = state.refreshGeneration;
  renderSubscriptionLine(ctx, state);
  state.inFlight = adapter.fetchUsage(ctx.signal).then((snapshot) => {
    if (state.refreshGeneration !== generation) return snapshot;
    state.snapshot = snapshot;
    state.lastRefreshAt = Date.now();
    renderSubscriptionLine(ctx, state);
    return snapshot;
  }).finally(() => {
    if (state.refreshGeneration === generation) {
      state.inFlight = undefined;
    }
  });
  return state.inFlight;
}

function scheduleRefresh(ctx: ExtensionContext, state: State): void {
  if (!state.adapter) return;
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = undefined;
    void refreshUsage(ctx, state, true);
  }, REFRESH_DEBOUNCE_MS);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function buildDetails(snapshot: SubscriptionUsageSnapshot | undefined, state: State): string {
  if (!state.adapter) {
    const header = `Provider: ${state.model?.provider ?? "unknown"}${state.model?.id ? ` · Model: ${state.model.id}` : ""}`;
    if (state.lastTokPerSec === undefined) return `${header}\nSubscription tracking inactive for this provider.`;
    const tokPerSecLine = `Last response: ${state.lastTokPerSec} tok/s` +
      (state.cumulativeDurationMs > 0
        ? ` · Session avg: ${Math.round(state.cumulativeOutput / (state.cumulativeDurationMs / 1000))} tok/s`
        : "");
    return `${header}\n${tokPerSecLine}`;
  }
  if (!snapshot) return "Subscription usage has not been loaded yet.";
  if (snapshot.error) return `${snapshot.providerDisplayName}: ${snapshot.error}`;
  if (snapshot.accounts.length === 0) {
    const costLine = state.cumulativeCost > 0 ? `\nSession cost: $${state.cumulativeCost.toFixed(2)}` : "";
    const modelInfo = state.model?.id ? ` · Model: ${state.model.id}` : "";
    return `Provider: ${snapshot.providerDisplayName}${modelInfo} · Fetched: ${new Date(snapshot.fetchedAt).toLocaleTimeString()}\n${snapshot.providerDisplayName} does not expose usage windows.${costLine}`;
  }

  const columns: { key: string; label: string; get: (a: SubscriptionAccountSnapshot) => string }[] = [
    { key: "account", label: "ACCOUNT", get: (a) => a.accountLabel ?? "unknown" },
    { key: "plan", label: "PLAN", get: (a) => a.plan ?? "?" },
  ];

  const hasFiveHour = snapshot.accounts.some((a) => a.fiveHour);
  const hasWeekly = snapshot.accounts.some((a) => a.weekly);
  if (hasFiveHour) columns.push({ key: "five", label: "ROLLING", get: (a) => formatRemaining(a.fiveHour) });
  if (hasWeekly) columns.push({ key: "weekly", label: "WEEKLY", get: (a) => formatRemaining(a.weekly) });
  const rows = snapshot.accounts.map((account) => ({
    active: account.isActive ? "*" : " ",
    snapshot: account,
  }));

  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col.key] = Math.max(col.label.length, ...snapshot.accounts.map((a) => col.get(a).length));
  }

  const headerCols = columns.map((c) => pad(c.label, widths[c.key]));
  const header = `  ${headerCols.join("  ")}  LAST ACTIVITY`;
  const sep = "-".repeat(header.length);
  const body = rows.map((row) => {
    const cols = columns.map((c) => pad(c.get(row.snapshot), widths[c.key]));
    return `${row.active} ${cols.join("  ")}  ${row.snapshot.lastActivity ?? ""}`;
  });

  const costLine = state.cumulativeCost > 0 ? `\nSession cost: $${state.cumulativeCost.toFixed(2)}` : "";
  const tokPerSecLine = state.lastTokPerSec !== undefined
    ? `\nLast response: ${state.lastTokPerSec} tok/s` +
      (state.cumulativeDurationMs > 0
        ? ` · Session avg: ${Math.round(state.cumulativeOutput / (state.cumulativeDurationMs / 1000))} tok/s`
        : "")
    : "";
  const lines = [`Provider: ${snapshot.providerDisplayName} · Model: ${state.model?.id ?? "unknown-model"} · Fetched: ${new Date(snapshot.fetchedAt).toLocaleTimeString()}${costLine}${tokPerSecLine}`, "", header, sep, ...body];
  if (!hasFiveHour && !hasWeekly) {
    lines.push("", `${snapshot.providerDisplayName} does not expose usage windows.`);
  }
  // Z.ai extras: MCP/month allowance (from TIME_LIMIT) + per-model/per-tool breakdown.
  const mcpAcct = snapshot.accounts.find((a) => a.mcpMonthly);
  if (mcpAcct && mcpAcct.mcpMonthly) lines.push("", `MCP/month: ${formatRemaining(mcpAcct.mcpMonthly)}`);
  for (const a of snapshot.accounts) if (a.usageBreakdown) lines.push("", a.usageBreakdown);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  const state: State = { lastRefreshAt: 0, refreshGeneration: 0, cumulativeOutput: 0, cumulativeDurationMs: 0, cumulativeCost: 0 };

  pi.on("session_start", async (_event, ctx) => {
    updateActiveAdapter(ctx, state, ctx.model);
    if (state.adapter) void refreshUsage(ctx, state, true);
  });

  pi.on("model_select", async (event, ctx) => {
    updateActiveAdapter(ctx, state, event.model);
    if (state.adapter) void refreshUsage(ctx, state, true);
  });

  pi.on("before_provider_request", async (_event, _ctx) => {
    state.responseStartTime = Date.now();
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant") {
      state.cumulativeCost += (event.message.usage as any)?.cost?.total ?? 0;
      if (state.responseStartTime) {
        const output = (event.message.usage as any)?.output ?? 0;
        const elapsed = Date.now() - state.responseStartTime;
        state.responseStartTime = undefined;
        if (elapsed > 0 && output > 0) {
          state.lastTokPerSec = Math.round(output / (elapsed / 1000));
          state.cumulativeOutput += output;
          state.cumulativeDurationMs += elapsed;
        }
      }
      renderSubscriptionLine(ctx, state);
    }
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (event.status >= 400) {
      state.responseStartTime = undefined;
    }
    if (state.adapter) scheduleRefresh(ctx, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTimer(state);
    // ponytail: session is being torn down (new/fork/switch/reload). Pi invalidates
    // this ctx next; no-op any in-flight fetch .then that captured it, and drop the
    // stale promise so the next session fetches fresh instead of returning it.
    state.inFlight = undefined;
    state.refreshGeneration++;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("sub", {
    description: "Show subscription usage for the current supported model provider (use /sub refresh to force refresh).",
    handler: async (args, ctx) => {
      updateActiveAdapter(ctx, state, ctx.model);
      const command = args.trim().toLowerCase();
      const force = command === "refresh";
      const snapshot = state.adapter ? await refreshUsage(ctx, state, force || !state.snapshot) : undefined;
      const details = buildDetails(snapshot ?? state.snapshot, state);
      pi.sendMessage({ customType: MESSAGE_TYPE, content: details, display: true });
      if (force) ctx.ui.notify("Subscription usage refreshed", "info");
    },
  });
}
