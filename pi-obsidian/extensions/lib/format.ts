/**
 * Generic list formatter for obsidian CLI JSON output.
 * Each item is mapped through `fn(item)` and joined by newlines.
 */
export function formatList(items: unknown, fn: (item: Record<string, unknown>) => string, emptyMsg = ""): string {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return emptyMsg;
  return arr.map((item: any) => fn(item as Record<string, unknown>)).join("\n");
}

/**
 * Format search results.
 * Handles:
 * - array of strings (search with format=json returns ["path1", "path2"])
 * - array of { file, matches } objects (search:context)
 * - array of { filename, match } objects (legacy)
 */
export function formatSearchResults(parsed: unknown, groupByFile = false): string {
  if (!parsed) return "No results found.";
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (arr.length === 0) return "No results found.";

  // Group by file when requested
  if (groupByFile) {
    const groups = new Map<string, string[]>();
    for (const item of arr) {
      if (typeof item === "string") {
        const file = item;
        if (!groups.has(file)) groups.set(file, []);
        continue;
      }
      const map = item as Record<string, unknown>;
      const file = String(map.file ?? map.filename ?? map.path ?? map.name ?? "(unknown)");
      if (!groups.has(file)) groups.set(file, []);
      const matches = map.matches as Array<{ line?: number; text?: string }> | undefined;
      if (matches && Array.isArray(matches) && matches.length > 0) {
        for (const m of matches) {
          groups.get(file)!.push(`  line ${m.line ?? "?"}: ${(m.text ?? "").trim()}`);
        }
      } else {
        const excerpt = String(map.match ?? map.excerpt ?? "");
        if (excerpt) groups.get(file)!.push(`    ${excerpt.replace(/\n/g, "\n    ")}`);
      }
    }
    const lines: string[] = [];
    for (const [file, hits] of [...groups.entries()].sort()) {
      lines.push(`\n### ${file}`);
      lines.push(...hits);
    }
    return lines.length > 0 ? lines.join("\n").trim() : "No results found.";
  }

  return arr.map((item: unknown): string => {
    if (typeof item === "string") {
      return item;
    }
    const map = item as Record<string, unknown>;
    const name = String(map.file ?? map.filename ?? map.path ?? map.name ?? "(unknown)");
    const matches = map.matches as Array<{ line?: number; text?: string }> | undefined;
    if (matches && Array.isArray(matches) && matches.length > 0) {
      const lines = matches.map((m) => `  line ${m.line ?? "?"}: ${(m.text ?? "").trim()}`).join("\n");
      return `${name}\n${lines}`;
    }
    const excerpt = String(map.match ?? map.excerpt ?? "");
    if (excerpt) return `${name}\n    ${excerpt.replace(/\n/g, "\n    ")}`;
    return name;
  }).join("\n");
}

function taskPrefix(status: string, completed?: boolean): string {
  if (completed === true) return "[x]";
  if (status === " " || status === "" || status === undefined) return "[ ]";
  if (status === "x") return "[x]";
  return `[${status}]`;
}

/**
 * Format tasks list — optionally grouped by file.
 * Pass `_groupByFile: true` in any task item to trigger grouping.
 */
export function formatTasks(parsed: unknown, groupByFile = false): string {
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) return "No tasks found.";

  if (!groupByFile) {
    return formatList(parsed, (t) => {
      const status = (t.status ?? "") as string;
      const text = (t.text ?? t.content ?? "") as string;
      const file = (t.filename ?? t.path ?? "") as string;
      const line = (t.line ?? "") as string;
      const location = file ? (line ? `${file}:${line}` : file) : "";
      const prefix = taskPrefix(status, t.completed as boolean | undefined);
      return `${prefix} ${text}${location ? ` — ${location}` : ""}`;
    }, "No tasks found.");
  }

  // Grouped by file
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const t of parsed as Array<Record<string, unknown>>) {
    const file = (t.filename ?? t.path ?? "(unknown)") as string;
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file)!.push(t);
  }

  const lines: string[] = [];
  for (const [file, tasks] of [...groups.entries()].sort()) {
    lines.push(`\n### ${file}`);
    for (const t of tasks) {
      const status = (t.status ?? "") as string;
      const text = (t.text ?? t.content ?? "") as string;
      const line = (t.line ?? "") as string;
      const prefix = taskPrefix(status, t.completed as boolean | undefined);
      lines.push(`${prefix} ${text}${line ? ` (line ${line})` : ""}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No tasks found.";
}

/**
 * Filter tasks by status and return formatted grouped output.
 */
export function formatTasksFiltered(parsed: unknown, status?: "open" | "done" | "all"): string {
  if (!parsed || !Array.isArray(parsed)) return "No tasks found.";

  const filtered = (parsed as Array<Record<string, unknown>>).filter(t => {
    if (typeof t !== "object" || t === null) return status === "all" || status === "open" || !status;
    if (!status || status === "all") return true;
    const isDone = (t.status === "x" || t.completed === true);
    return status === "done" ? isDone : !isDone;
  });

  // ponytail: reuse grouped formatter
  return formatTasks(filtered, true);
}

/**
 * Format tags list.
 */
export function formatTags(parsed: unknown): string {
  if (typeof parsed === "number") return String(parsed);
  if (typeof parsed === "string") return parsed.trim() || "No tags found.";
  return formatList(parsed, (t) => `  ${t.tag ?? t.name}: ${t.count ?? t.frequency ?? 1}`, "No tags found.");
}

/**
 * Format backlinks list.
 */
export function formatLinks(parsed: unknown, label = "Links"): string {
  return formatList(parsed, (l) => `  ${l.filename ?? l.path ?? l.file ?? l.name ?? l.link ?? "(unknown)"}`, `No ${label.toLowerCase()}.`);
}

/**
 * Format outline/headings.
 */
export function formatOutline(parsed: unknown): string {
  if (parsed == null) return "(no headings)";
  if (!Array.isArray(parsed)) return String(parsed);
  if (parsed.length === 0) return "(no headings)";
  const tree = parsed as Array<{ level?: number; heading?: string; text?: string; children?: unknown[] }>;
  const lines: string[] = [];
  function walk(items: typeof tree, depth = 0) {
    for (const item of items) {
      const indent = "  ".repeat(depth);
      const prefix = item.level ? "#".repeat(item.level) : "-";
      lines.push(`${indent}${prefix} ${item.heading ?? item.text ?? ""}`);
      if (item.children) walk(item.children as typeof tree, depth + 1);
    }
  }
  walk(tree);
  return lines.join("\n");
}

/**
 * Format outgoing links list.
 * Handles both raw text (CLI default) and JSON array output.
 */
export function formatOutgoingLinks(parsed: unknown): string {
  if (!parsed) return "No outgoing links.";
  // Handle raw text (links doesn't support format=json)
  if (typeof parsed === "string") {
    const lines = parsed.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return "No outgoing links.";
    return lines.map((l) => `  ${l}`).join("\n");
  }
  // Handle single link object
  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const marker = obj.unresolved ? " (broken)" : "";
    return `  ${obj.link ?? obj.filename ?? obj.file ?? "(unknown)"}${marker}`;
  }
  // Handle JSON array
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return "No outgoing links.";
    return parsed.map((l: Record<string, unknown>) => {
      const marker = l.unresolved ? " (broken)" : "";
      return `  ${l.link ?? l.filename ?? l.file ?? "(unknown)"}${marker}`;
    }).join("\n");
  }
  return String(parsed);
}

/**
 * Format file info.
 */
export function formatFileInfo(parsed: unknown): string {
  const info = parsed as Record<string, unknown> | null;
  if (!info) return "(no file info)";
  // Single file — show as key: value
  if (typeof info === "object" && !Array.isArray(info)) {
    return Object.entries(info)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
  }
  return String(parsed);
}

/**
 * Format properties list into a readable table or list.
 * Handles:
 * - number (from total flag)
 * - string[] (from default text output)
 * - { name, type, count }[] (from JSON format with counts)
 */
export function formatProperties(parsed: unknown): string {
  // Number = total count
  if (typeof parsed === "number") return String(parsed);
  // String = raw text output
  if (typeof parsed === "string") return parsed.trim() || "No properties found.";
  // null/undefined
  if (!parsed) return "No properties found.";
  // Array of strings (text list of property names)
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "string") {
    return (parsed as string[]).join("\n");
  }
  // Array of { name, count } from vault-wide JSON
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return "No properties found.";
    return parsed.map((p: Record<string, unknown>) => `  ${p.name ?? "?"}: ${p.count ?? p.type ?? ""}`).join("\n");
  }
  // Single-file properties as object
  if (typeof parsed !== "object") return String(parsed);
  const obj = parsed as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
}

/**
 * Format aliases list.
 */
export function formatAliases(parsed: unknown): string {
  if (!parsed || (Array.isArray(parsed) && parsed.length === 0)) return "No aliases.";
  if (typeof parsed === "string") return parsed.trim();
  const items = parsed as Array<{ alias?: string; filename?: string }>;
  return items.map((a) => `  ${a.alias ?? a.filename ?? ""}`).join("\n");
}

/**
 * Format word count result.
 */
export function formatWordCount(parsed: unknown): string {
  if (!parsed) return "(no data)";
  if (typeof parsed === "object") {
    const wc = parsed as Record<string, unknown>;
    return Object.entries(wc)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
  }
  return String(parsed);
}
