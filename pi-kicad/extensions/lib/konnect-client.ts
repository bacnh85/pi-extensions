// Minimal JSON-RPC 2.0 client for the Konnect HTTP transport.
//
// Konnect's Streamable HTTP transport (crates/konnect/src/transport/http.rs) is
// stateless per request: POST /mcp with one JSON-RPC body -> one JSON response,
// no initialize handshake required for tools/call. So we don't need the MCP SDK
// — just fetch() + JSON-RPC envelopes.

// ---------------------------------------------------------------------------
// Types — match Konnect's wire shapes (crates/konnect-core/src/mcp/*.rs)
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** A single content item returned by a Konnect tools/call result. */
export type KonnectContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string };

/** Result of a Konnect tools/call. */
export interface KonnectCallResult {
  content: KonnectContent[];
  isError?: boolean;
}

/** Pi tool-result content item (matches the codebase's proven text pattern). */
export interface PiContent {
  type: "text";
  text: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without a server)
// ---------------------------------------------------------------------------

let nextId = 1;

/** Build a JSON-RPC 2.0 request envelope. */
export function buildJsonRpcRequest(
  method: string,
  params?: unknown,
  id: number = nextId++,
): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: "2.0", id, method };
  if (params !== undefined) req.params = params;
  return req;
}

/** Reset the monotonic id counter (tests). */
export function _resetRequestId(): void {
  nextId = 1;
}

/**
 * Pull the `result` out of a JSON-RPC response, throwing on `{error}`.
 * Returns the raw result value for the caller to interpret.
 */
export function extractResult(response: JsonRpcResponse): unknown {
  if (response.error) {
    const e = response.error;
    throw new Error(`Konnect RPC error ${e.code}: ${e.message}`);
  }
  return response.result;
}

/**
 * Map Konnect content items to Pi tool-result content.
 *
 * Text items pass through, hard-capped at the remaining budget (the truncation
 * marker is reserved within the budget so total never exceeds maxChars). Image
 * items become a short text summary + the raw base64 is preserved in `details`
 * so nothing is lost; the model cannot usefully consume a multi-MB base64 blob
 * inline. Native ImageContent could replace this once its exact Pi shape is
 * confirmed.
 *   // ponytail: image-as-text-summary; swap to native ImageContent if/when needed
 */
const TRUNC_MARKER = "\n…(truncated)";

export function mapContent(
  content: KonnectContent[] | undefined,
  opts: { maxChars: number },
): { piContent: PiContent[]; images: { data: string; mimeType?: string }[] } {
  const piContent: PiContent[] = [];
  const images: { data: string; mimeType?: string }[] = [];
  if (!content) return { piContent, images };

  let used = 0;
  for (const item of content) {
    if (item.type === "text") {
      const remaining = Math.max(0, opts.maxChars - used);
      let text = item.text;
      if (text.length > remaining) {
        // Reserve marker space, then hard-cap so total stays within budget.
        text = (text.slice(0, Math.max(0, remaining - TRUNC_MARKER.length)) + TRUNC_MARKER).slice(
          0,
          remaining,
        );
      }
      if (text.length) {
        piContent.push({ type: "text", text });
        used += text.length;
      }
    } else {
      images.push({ data: item.data, mimeType: item.mimeType });
      const note = `[image: ${item.mimeType ?? "image/png"}, ${item.data.length} chars base64]`;
      piContent.push({ type: "text", text: note });
    }
  }
  return { piContent, images };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export interface CallOptions {
  port: number;
  method: string;
  params?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const HEALTH_PATH = "/health";
export const MCP_PATH = "/mcp";

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** True if a healthy Konnect daemon answers on the port. */
export async function probeHealth(
  port: number,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2000);
    const res = await f(`${baseUrl(port)}${HEALTH_PATH}`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok && (await res.text()).trim() === "ok";
  } catch {
    return false;
  }
}

/**
 * Send one JSON-RPC request to Konnect's POST /mcp endpoint and return the
 * parsed `result`. Throws on HTTP failure or a JSON-RPC `{error}`.
 */
export async function callKonnect(opts: CallOptions): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  if (opts.signal) opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });

  let res: Response;
  try {
    res = await f(`${baseUrl(opts.port)}${MCP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(buildJsonRpcRequest(opts.method, opts.params)),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Konnect HTTP ${res.status}: ${await res.text().catch(() => "")}`.trim());
  }
  const body = (await res.json()) as JsonRpcResponse;
  return extractResult(body);
}
