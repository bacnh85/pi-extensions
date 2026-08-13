/**
 * A2A Protocol v1.0 data model — types, Agent Card construction, JSON-RPC
 * framing, Part builders/extractors, task lifecycle.
 *
 * Wire shape follows the A2A Protocol v1.0 (JSON-RPC 2.0 binding over HTTP),
 * stewarded by the Linux Foundation: https://a2a-protocol.org/latest/specification/
 *
 * Ported from Hermes' pure-stdlib Python implementation
 * (plugins/platforms/a2a/protocol.py). Tolerant of v0.3 peers (legacy `kind`
 * Parts and `agent.json` card path).
 */

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Task lifecycle states (v1.0 SCREAMING_SNAKE_CASE)
// ---------------------------------------------------------------------------

export const STATE_SUBMITTED = "TASK_STATE_SUBMITTED";
export const STATE_WORKING = "TASK_STATE_WORKING";
export const STATE_INPUT_REQUIRED = "TASK_STATE_INPUT_REQUIRED";
export const STATE_AUTH_REQUIRED = "TASK_STATE_AUTH_REQUIRED";
export const STATE_COMPLETED = "TASK_STATE_COMPLETED";
export const STATE_FAILED = "TASK_STATE_FAILED";
export const STATE_CANCELED = "TASK_STATE_CANCELED";
export const STATE_REJECTED = "TASK_STATE_REJECTED";

export const TERMINAL_STATES = new Set<string>([
  STATE_COMPLETED,
  STATE_FAILED,
  STATE_CANCELED,
  STATE_REJECTED,
]);

// v0.3 lowercase aliases (some peers still send these).
const STATE_ALIASES: Record<string, string> = {
  submitted: STATE_SUBMITTED,
  working: STATE_WORKING,
  input_required: STATE_INPUT_REQUIRED,
  completed: STATE_COMPLETED,
  failed: STATE_FAILED,
  canceled: STATE_CANCELED,
  canceled_v03: STATE_CANCELED,
  rejected: STATE_REJECTED,
};

/** Normalise an inbound state string to the v1.0 SCREAMING_SNAKE_CASE form. */
export function normalizeState(state: string | undefined | null): string {
  if (!state) return "";
  if (state.startsWith("TASK_STATE_")) return state;
  const lower = state.toLowerCase();
  return STATE_ALIASES[lower] ?? state;
}

// ---------------------------------------------------------------------------
// Message roles
// ---------------------------------------------------------------------------

export const ROLE_USER = "ROLE_USER";
export const ROLE_AGENT = "ROLE_AGENT";

// v0.3 used lowercase "user" / "agent".
export function normalizeRole(role: string | undefined | null): string {
  if (!role) return ROLE_USER;
  const r = role.toLowerCase();
  if (r === "user") return ROLE_USER;
  if (r === "agent" || r === "assistant" || r === "model") return ROLE_AGENT;
  return role.startsWith("ROLE_") ? role : ROLE_USER;
}

// ---------------------------------------------------------------------------
// JSON-RPC / A2A error codes
// ---------------------------------------------------------------------------

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;
// A2A spec-defined:
export const ERR_TASK_NOT_FOUND = -32001;
export const ERR_TASK_NOT_CANCELABLE = -32002;
export const ERR_PUSH_NOT_SUPPORTED = -32003;
// Custom (implementation-defined server-error space, clear of A2A block):
export const ERR_UNAUTHORIZED = -32050;
export const ERR_RATE_LIMITED = -32051;
export const ERR_UNTRUSTED_PEER = -32052;
export const ERR_UNSUPPORTED_OP = -32053;

// ---------------------------------------------------------------------------
// Timestamps / IDs
// ---------------------------------------------------------------------------

/** ISO 8601 UTC with millisecond precision (A2A v1.0). */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, (m) => m); // Date already gives ms precision
}

/** crypto.randomUUID where available, else hex fallback. */
export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

export function newTaskId(): string {
  return "task-" + uuid().replace(/-/g, "").slice(0, 16);
}

export function newContextId(): string {
  return "ctx-" + uuid().replace(/-/g, "").slice(0, 16);
}

export function newMessageId(): string {
  return uuid().replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// Agent Card (v1.0)
// ---------------------------------------------------------------------------

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

export interface AgentCard {
  name: string;
  description?: string;
  url: string; // convenience for pre-1.0 clients
  version: string;
  provider?: { organization: string; url: string };
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: string;
    protocolVersion: string;
  }>;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
    extendedAgentCard: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  securitySchemes?: Record<string, { type: string; scheme: string }>;
  security?: Array<Record<string, string[]>>;
}

export function buildAgentCard(opts: {
  name: string;
  url: string;
  description?: string;
  skills?: AgentSkill[];
  streaming?: boolean;
  pushNotifications?: boolean;
  authRequired?: boolean;
}): AgentCard {
  const card: AgentCard = {
    name: opts.name,
    description: opts.description ?? "",
    url: opts.url,
    version: "1.0.0",
    provider: { organization: "Pi Coding Agent", url: opts.url },
    supportedInterfaces: [
      {
        url: opts.url,
        protocolBinding: "JSONRPC",
        protocolVersion: PROTOCOL_VERSION,
      },
    ],
    capabilities: {
      streaming: !!opts.streaming,
      pushNotifications: !!opts.pushNotifications,
      stateTransitionHistory: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: opts.skills ?? [
      {
        id: "coding",
        name: "coding",
        description: "General-purpose coding agent (read, edit, run, debug)",
        tags: ["coding", "refactor", "tests"],
      },
    ],
  };
  if (opts.authRequired) {
    card.securitySchemes = { bearer: { type: "http", scheme: "bearer" } };
    card.security = [{ bearer: [] }];
  }
  return card;
}

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export function jsonrpcResult(id: JsonRpcRequest["id"], result: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function jsonrpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: any,
): JsonRpcResponse {
  const err: JsonRpcResponse["error"] = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

/**
 * Wrap a SendMessage result. v1.0 wraps as {task} or {message}; legacy methods
 * may return a bare Task/Message. This wraps a bare payload correctly.
 */
export function sendMessageResponse(payload: any): any {
  if (typeof payload === "object" && payload && payload.status && payload.id) {
    return { task: payload };
  }
  return { message: payload };
}

/** Unwrap a v1.0 {task}|{message} response, or pass a legacy bare payload through. */
export function unwrapSendMessageResponse(result: any): any {
  if (result && typeof result === "object") {
    if (result.task && typeof result.task === "object") return result.task;
    if (result.message && typeof result.message === "object") return result.message;
  }
  return result;
}

// StreamResponse builders (v1.0).
export const streamTask = (task: any): any => ({ task });
export const streamMessage = (message: any): any => ({ message });
export const streamStatusUpdate = (task: any): any => ({ statusUpdate: task });
export const streamArtifactUpdate = (artifact: any): any => ({ artifactUpdate: artifact });

// ---------------------------------------------------------------------------
// Parts (v1.0 member-presence discriminated; v0.3 `kind` tolerant)
// ---------------------------------------------------------------------------

export interface TextPart {
  text: string;
  mediaType?: string;
}
export interface FilePart {
  url?: string;
  raw?: string;
  filename?: string;
  mediaType?: string;
}
export interface DataPart {
  data: any;
  mediaType?: string;
}
export type Part = TextPart | FilePart | DataPart | Record<string, any>;

export function textPart(text: string): TextPart {
  return { text, mediaType: "text/plain" };
}

export function filePart(opts: {
  url?: string;
  raw?: string;
  filename?: string;
  mediaType?: string;
}): FilePart {
  const p: FilePart = { mediaType: opts.mediaType ?? "application/octet-stream" };
  if (opts.filename) p.filename = opts.filename;
  if (opts.url) p.url = opts.url;
  else if (opts.raw) p.raw = opts.raw;
  return p;
}

export function dataPart(data: any, mediaType = "application/json"): DataPart {
  return { data, mediaType };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  role: string;
  parts: Part[];
  messageId: string;
  contextId?: string;
  taskId?: string;
}

export function textMessage(role: string, text: string, contextId = ""): Message {
  const msg: Message = { role, parts: [textPart(text)], messageId: newMessageId() };
  if (contextId) msg.contextId = contextId;
  return msg;
}

export function messageWithParts(
  role: string,
  parts: Part[],
  contextId = "",
): Message {
  const msg: Message = { role, parts, messageId: newMessageId() };
  if (contextId) msg.contextId = contextId;
  return msg;
}

/**
 * Pull concatenated text from an A2A Message / Task result / params payload.
 *
 * v1.0 Parts carry the payload member directly (member-presence, no `kind`).
 * v0.3 used `kind: "text"|"file"|"data"`; pre-0.3 used `type`. All three put
 * text in `part.text`. File Parts are rendered as `[file: name] url`; data
 * Parts as JSON — so the agent sees inbound richness even from text-only reply.
 */
export function extractText(messageOrParams: any): string {
  if (!messageOrParams || typeof messageOrParams !== "object") {
    return typeof messageOrParams === "string" ? messageOrParams : "";
  }
  const msg = messageOrParams.message ?? messageOrParams;
  // If this is a Task/result with artifacts, extract from the first artifact.
  const artifacts = messageOrParams?.artifacts;
  if (Array.isArray(artifacts)) {
    for (const a of artifacts) {
      const t = extractText(a);
      if (t) return t;
    }
  }
  // If this is a Task with a status.message, extract from that.
  const statusMsg = messageOrParams?.status?.message;
  if (statusMsg && typeof statusMsg === "object") {
    const t = extractText(statusMsg);
    if (t) return t;
  }
  const parts: any[] = Array.isArray(msg?.parts) ? msg.parts : [];
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    // v1.0 text part
    if (typeof part.text === "string") {
      chunks.push(part.text);
      continue;
    }
    // v0.3 kind === "text"
    if (part.kind === "text" && typeof part.text === "string") {
      chunks.push(part.text);
      continue;
    }
    // v1.0 file part with url
    if (typeof part.url === "string" && part.url) {
      const fname = part.filename || part.name || "";
      const mtype = part.mediaType || part.mimeType || "";
      const label = fname ? `[file: ${fname}]` : "[file]";
      chunks.push(`${label} ${part.url}` + (mtype ? ` (${mtype})` : ""));
      continue;
    }
    // v0.3 file with nested fileWithUri
    const v03file = part.file;
    if (v03file && typeof v03file === "object" && typeof v03file.fileWithUri === "string") {
      const uri = v03file.fileWithUri;
      const fname = v03file.name || "";
      const mtype = v03file.mimeType || "";
      const label = fname ? `[file: ${fname}]` : "[file]";
      chunks.push(`${label} ${uri}` + (mtype ? ` (${mtype})` : ""));
      continue;
    }
    // v1.0 file part with raw base64 — note but don't decode
    if (typeof part.raw === "string") {
      const fname = part.filename || "";
      const mtype = part.mediaType || "";
      const label = fname ? `[file: ${fname}]` : "[file]";
      chunks.push(`${label} ${part.raw.length} bytes base64-encoded` + (mtype ? ` (${mtype})` : ""));
      continue;
    }
    // v1.0 data part — include JSON content
    if (part.data !== undefined) {
      try {
        chunks.push(JSON.stringify(part.data));
      } catch {
        chunks.push("[unserializable data part]");
      }
      continue;
    }
  }
  return chunks.join("\n");
}

// ---------------------------------------------------------------------------
// Task construction
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  contextId: string;
  status: { state: string; message?: Message; timestamp?: string };
  history?: Message[];
  artifacts?: Array<{ artifactId: string; parts: Part[]; name?: string }>;
  kind?: string;
  metadata?: Record<string, any>;
}

export function buildTask(opts: {
  id: string;
  contextId: string;
  state?: string;
  message?: Message;
}): Task {
  return {
    id: opts.id,
    contextId: opts.contextId,
    status: {
      state: opts.state ?? STATE_SUBMITTED,
      message: opts.message,
      timestamp: nowIso(),
    },
  };
}
