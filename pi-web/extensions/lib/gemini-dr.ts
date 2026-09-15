// Pure-Node Deep Research client for gemini.google.com — replaces the
// gemini-reverse research path, whose payload/parser drift causes 1184 and
// "research_id missing" failures. Wire shapes validated live 2026-09-13/14
// (plan + confirm turns executed via /tmp/gemini-dr2.mjs; fixtures in
// extensions/test/unit/fixtures/). Deep research is an ordinary chat turn
// flagged deep_research=True: plan turn → "Start research" confirm turn →
// poll LIST_CONVERSATION_TURNS until the report text arrives.
//
// NOTE: report polling uses the batchexecute XSRF `at` token, which only a
// live session's pages carry. On stale sessions the plan/confirm steps still
// execute (proven) but the poll returns empty payloads — geminiResearch
// surfaces that as a partial result with a clear note.

import crypto from "node:crypto";
import https from "node:https";
import { URL } from "node:url";
import { abortableSleep } from "./retry";

const DR_APP_URL = "https://gemini.google.com/app";
const DR_GENERATE_URL = "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const DR_BATCH_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute";
const DR_CONFIRM_PROMPT = "Start research";
const DR_TOKEN_BYTES = 1950; // → 2600 base64url chars, matches gemini_webapi

export const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

export interface DrResult {
  title?: string;
  text: string;
  sources: string[];
  /** Present when the cycle ran but the report was not retrievable (stale session): plan/confirm transcript stands in. */
  partial?: string;
}

/** Injectable transport: GET/POST returning the full (already buffered) body. */
export type DrHttp = (
  url: string,
  opts: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; headers: { get(name: string): string | null; "set-cookie"?: string[] }; buf: Buffer }>;

export interface DrOptions {
  cookie: { psid: string; psidts?: string };
  query: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** @internal test injection */
  http?: DrHttp;
}

export function chromeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "user-agent": CHROME_UA,
    "sec-ch-ua": '"Chromium";v="145", "Google Chrome";v="145", "Not-A.Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://gemini.google.com",
    referer: "https://gemini.google.com/",
    ...extra,
  };
}

/** Default transport: node:https with redirect-following (max 5) + cookie-jar accumulation over the base cookie. */
export function defaultHttp(): DrHttp {
  return async (url, opts) => {
    const { rest, jar } = extractCookieJar(opts.headers);
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; buf: Buffer }>((resolve, reject) => {
        const req = https.request(new URL(current), { method: opts.method, headers: { ...rest, Cookie: cookie }, maxHeaderSize: 256 * 1024 }, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, buf: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.setTimeout(120_000, () => req.destroy(new Error("timeout")));
        if (opts.body) req.write(opts.body);
        req.end();
      });
      for (const line of res.headers["set-cookie"] ?? []) {
        const pair = line.split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      return {
        status: res.status,
        headers: { get: (n) => (res.headers[n.toLowerCase()] as string | undefined) ?? null, "set-cookie": res.headers["set-cookie"] },
        buf: res.buf,
      };
    }
    throw new Error("too many redirects");
  };
}

/** Case-independent Cookie-header extraction + jar seeding. Callers pass the
 * auth cookie as `cookie` (chromeHeaders) — seeding must not depend on case,
 * and the original header must be removed so exactly one Cookie header ships
 * per hop (a stray empty `Cookie:` renders pages logged-out).
 * @internal exported for tests */
export function extractCookieJar(headers: Record<string, string>): { rest: Record<string, string>; jar: Map<string, string> } {
  const rest: Record<string, string> = {};
  const jar = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "cookie") {
      rest[k] = v;
      continue;
    }
    for (const pair of v.split("; ")) {
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
  }
  return { rest, jar };
}

/** Byte-exact frame splitter: prefix is the byte length INCLUDING the trailing newline. */
export function parseFrames(buf: Buffer): string[] {
  const start = buf.indexOf(")]}'");
  if (start === -1) return [];
  const stream = buf.slice(start + 4);
  let i = 0;
  const frames: string[] = [];
  while (i < stream.length) {
    while (i < stream.length && stream[i] === 0x0a) i++;
    const nl = stream.indexOf(0x0a, i);
    if (nl === -1) break;
    const len = parseInt(stream.slice(i, nl).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    frames.push(stream.slice(nl + 1, nl + len).toString("utf8").trimEnd());
    i = nl + len;
  }
  return frames;
}

/** All strings from a frame set, recursing into escaped inner-JSON payloads. */
export function frameStrings(frames: string[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown, d: number): void => {
    if (v == null || d > 14) return;
    if (typeof v === "string") {
      out.push(v);
      if (v.startsWith("[") || v.startsWith("{")) { try { walk(JSON.parse(v), d + 1); } catch { /* not json */ } }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
    if (typeof v === "object") { for (const x of Object.values(v)) walk(x, d + 1); }
  };
  for (const f of frames) { try { walk(JSON.parse(f), 0); } catch { /* skip */ } }
  return out;
}

/** The plan title arrives as a {"11":["<title>"]} sparse-metadata leaf inside the frames. */
export function extractPlanTitle(frames: string[]): string | undefined {
  let title: string | undefined;
  const walk = (v: unknown, d: number): void => {
    if (v == null || d > 14 || title) return;
    if (typeof v === 'string') {
      // the payload arrives as an escaped inner-JSON string — recurse into it
      if (v.startsWith('[') || v.startsWith('{')) { try { walk(JSON.parse(v), d + 1); } catch { /* not json */ } }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
    if (typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      if (!title && Array.isArray(rec['11']) && typeof rec['11'][0] === 'string' && (rec['11'][0] as string).length > 3) {
        title = rec['11'][0] as string;
      }
      for (const x of Object.values(rec)) walk(x, d + 1);
    }
  };
  for (const f of frames) { try { walk(JSON.parse(f), 0); } catch { /* skip */ } }
  return title;
}

export function extractChatIds(strings: string[]): { cid?: string; rid?: string } {
  for (const s of strings) {
    const cid = (s.match(/c_[0-9a-f]{16}/) || [])[0];
    const rid = (s.match(/r_[0-9a-f]{16}/) || [])[0];
    if (cid && rid) return { cid, rid };
  }
  return {};
}

function buildInner(opts: { prompt: string; metadata: unknown[]; cidRid?: { cid: string; rid: string }; requestId: string }): unknown[] {
  const inner: unknown[] = new Array(81).fill(null);
  inner[0] = [opts.prompt, 0, null, null, null, null, 0];
  inner[1] = ["en"];
  inner[2] = opts.cidRid ? [opts.cidRid.cid, opts.cidRid.rid] : opts.metadata;
  inner[3] = "!" + crypto.randomBytes(DR_TOKEN_BYTES).toString("base64url");
  inner[4] = crypto.randomUUID().replace(/-/g, "");
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[49] = 1; // deep research
  inner[53] = 0;
  inner[54] = [[[[[1]]]]];
  inner[55] = [[1]];
  inner[61] = [];
  inner[68] = 1;
  inner[79] = 1;
  inner[80] = 1;
  inner[59] = opts.requestId;
  return inner;
}

export class DeepResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepResearchError";
  }
}

/**
 * Run the full DR cycle: plan turn → confirm turn ("Start research") → poll
 * LIST_CONVERSATION_TURNS until the report text lands. `http` is injectable
 * for tests; the default is a redirect-following node:https transport with a
 * cookie jar.
 */
export async function geminiDeepResearch(opts: DrOptions): Promise<DrResult> {
  const http = opts.http ?? defaultHttp();
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  const checkAbort = (): void => {
    if (opts.signal?.aborted) throw Object.assign(new Error("web_research aborted"), { name: "AbortError" });
  };

  // init: redirect-following page GET. SNlM0e may be absent on degraded
  // sessions — StreamGenerate tolerates at="" (proven live); batchexecute
  // polling will simply return empty until a live session provides it.
  const jar = new Map<string, string>();
  jar.set("__Secure-1PSID", opts.cookie.psid);
  if (opts.cookie.psidts) jar.set("__Secure-1PSIDTS", opts.cookie.psidts);
  const initRes = await http(DR_APP_URL, { method: "GET", headers: chromeHeaders({ accept: "text/html", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }) });
  for (const line of initRes.headers["set-cookie"] ?? []) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const page = initRes.buf.toString("utf8");
  const snlM0e = (page.match(/"SNlM0e":\s*"(.*?)"/) || [])[1] ?? "";
  const bl = (page.match(/"cfb2h":\s*"(.*?)"/) || [])[1] ?? "";
  const fsid = (page.match(/"FdrFJe":\s*"(.*?)"/) || [])[1] ?? "";

  const drTurn = async (prompt: string, cidRid?: { cid: string; rid: string }): Promise<{ strings: string[]; frames: string[]; ids: { cid?: string; rid?: string } }> => {
    checkAbort();
    const requestId = crypto.randomUUID().toUpperCase();
    const inner = buildInner({ prompt, metadata: ["", "", "", null, null, null, null, null, null, ""], cidRid, requestId });
    const params = new URLSearchParams({ bl, hl: "en", _reqid: "100100", rt: "c" });
    if (fsid) params.set("f.sid", fsid);
    const body = new URLSearchParams({ at: snlM0e, "f.req": JSON.stringify([null, JSON.stringify(inner)]) }).toString();
    const res = await http(`${DR_GENERATE_URL}?${params}`, {
      method: "POST",
      headers: chromeHeaders({ cookie, "content-type": "application/x-www-form-urlencoded;charset=utf-8", "x-same-domain": "1", "x-goog-ext-525005358-jspb": `["${requestId}",1]` }),
      body,
    });
    if (res.status !== 200) throw new DeepResearchError(`deep research turn failed (HTTP ${res.status})`);
    const frames = parseFrames(res.buf);
    const strings = frameStrings(frames);
    const ids = extractChatIds(strings);
    if (!ids.cid) throw new DeepResearchError("deep research turn returned no chat id");
    return { strings, frames, ids };
  };

  // turn 1: plan
  const plan = await drTurn(opts.query);
  const title = extractPlanTitle(plan.frames);
  // turn 2: confirm — same chat, metadata [cid, rid]
  const confirm = await drTurn(DR_CONFIRM_PROMPT, { cid: plan.ids.cid!, rid: plan.ids.rid! });

  // poll: LIST_CONVERSATION_TURNS (hNvQHb) until the report text arrives.
  // Plan/confirm transcripts reappear verbatim in poll output — exclude any
  // string already seen in those turns so a plan transcript is never
  // returned as the report.
  // ponytail: exact-match exclusion; a real multi-turn poll fixture would
  // allow turn-index filtering instead
  const priorTurnStrings = new Set([...plan.strings, ...confirm.strings]);
  const pollOnce = async (): Promise<string[]> => {
    const fReq = JSON.stringify([[["hNvQHb", JSON.stringify([plan.ids.cid, 10, null, 1, [1], [4], null, 1]), null, "generic"]]]);
    const params = new URLSearchParams({ bl, hl: "en", _reqid: "200100", rt: "c" });
    const res = await http(`${DR_BATCH_URL}?${params}`, {
      method: "POST",
      headers: chromeHeaders({ cookie, "content-type": "application/x-www-form-urlencoded;charset=utf-8", "x-same-domain": "1" }),
      body: new URLSearchParams({ at: snlM0e, "f.req": fReq }).toString(),
    });
    if (res.status === 401 || res.status === 403) {
      // Hard auth rejection — unlike 200-with-empty (server fluctuation) this
      // cannot become a report on a later poll; surface it instead of spinning
      // until the deadline.
      throw new DeepResearchError(`report poll rejected (HTTP ${res.status}) — session cannot read this conversation`);
    }
    if (res.status !== 200) return []; // 429/5xx: transient — keep polling
    return frameStrings(parseFrames(res.buf)).filter((s) => s.length > 200 && !priorTurnStrings.has(s));
  };

  let reportStrings: string[] = [];
  let pollFailure: string | null = null;
  while (Date.now() < deadline) {
    checkAbort();
    try {
      reportStrings = await pollOnce();
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      pollFailure = err instanceof Error ? err.message : String(err);
      break;
    }
    if (reportStrings.length) break;
    const wait = Math.min(20_000, Math.max(0, deadline - Date.now()));
    if (wait <= 0) break;
    await abortableSleep(wait, opts.signal);
  }

  const text = reportStrings.join("\n\n");
  const sources = [...new Set((text.match(/https?:\/\/[^\s<>()\[\]{}"'`]+/g) ?? []).map((u) => u.replace(/[.,;:!?)\]]+$/, "")))].slice(0, 30);
  const result: DrResult = { title, text, sources };
  if (!text) {
    result.partial =
      `Research executed ("${title ?? opts.query}") and confirmed ("${DR_CONFIRM_PROMPT}"), but the report could not be retrieved` +
      (pollFailure ? ` (${pollFailure})` : " on this session (conversation read requires a live-session token)") +
      `. The report remains available in the Gemini web history for chat ${plan.ids.cid}.`;
  }
  return result;
}
