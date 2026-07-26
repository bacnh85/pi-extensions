// Sequential batch runner for Konnect tool calls.
//
// Konnect's file-mutating tools (create_symbol, add_schematic_component,
// connect_to_net, …) use read-modify-write + atomic rename. Concurrent calls
// on the same file race: the rename window makes sibling reads fail with
// "No such file or directory" or silently lose edits. So multi-step schematic
// capture MUST run strictly sequentially. This module runs a list of tool ops
// one after another (each awaited) and reports per-op results, and is pure
// given an injectable `callFn` so it is unit-tested without a live daemon.

export interface BatchOp {
  tool: string;
  arguments?: unknown;
}

export interface BatchResult {
  index: number;
  tool: string;
  ok: boolean;
  isError: boolean;
  /** Parsed Konnect result (content text parsed as JSON when possible). */
  result?: unknown;
  error?: string;
}

export interface BatchOutcome {
  results: BatchResult[];
  errors: number;
  stopped: boolean;
}

export interface BatchOptions {
  stopOnError?: boolean;
}

type Konnectish = { content?: { text?: string }[]; isError?: boolean };

/** Parse the text payload of a Konnect tools/call result, if it is JSON. */
function parsePayload(res: unknown): unknown {
  const r = res as Konnectish;
  const text = r?.content?.[0]?.text;
  if (typeof text !== "string") return res;
  try {
    return JSON.parse(text);
  } catch {
    return res;
  }
}

/**
 * Run `ops` sequentially via `callFn` (awaited one at a time). `callFn(op)`
 * should return a Konnect tools/call result or throw. Returns per-op outcomes
 * with parsed payloads so callers can extract data (e.g. pin coordinates)
 * between batches.
 */
export async function runBatch(
  ops: BatchOp[],
  callFn: (op: BatchOp) => Promise<unknown>,
  opts: BatchOptions = {},
): Promise<BatchOutcome> {
  const results: BatchResult[] = [];
  let errors = 0;
  let stopped = false;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    let res: unknown;
    let err: string | undefined;
    try {
      res = await callFn(op);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const parsed = err == null ? parsePayload(res) : undefined;
    const isError = err != null || (res as Konnectish)?.isError === true || !!(parsed as { error?: unknown })?.error;
    if (isError) errors++;
    results.push({ index: i, tool: op.tool, ok: !isError, isError, result: parsed, error: err });
    if (isError && opts.stopOnError) {
      stopped = true;
      break;
    }
  }
  return { results, errors, stopped };
}

/** Compact one-line-per-op summary for display. */
export function summarizeBatch(outcome: BatchOutcome): string {
  const lines = outcome.results.map((r) => {
    const detail = r.error
      ? `: ${r.error}`
      : r.isError && r.result && (r.result as { error?: { message?: string } }).error
        ? `: ${(r.result as { error: { message?: string } }).error.message ?? ""}`
        : "";
    return `${r.ok ? "✓" : "✗"} [${r.index}] ${r.tool}${detail}`;
  });
  const head = `batch: ${outcome.results.length} ops, ${outcome.errors} error(s)${
    outcome.stopped ? " (stopped at first error)" : ""
  }`;
  return [head, ...lines].join("\n");
}
