/**
 * Generic list formatter for obsidian CLI JSON output.
 * Each item is mapped through `fn(item)` and joined by newlines.
 */
function formatList(items: unknown, fn: (item: Record<string, unknown>) => string, emptyMsg = ""): string {
	const arr = Array.isArray(items) ? items : [];
	if (arr.length === 0) return emptyMsg;
	return arr.map((item: any) => fn(item as Record<string, unknown>)).join("\n");
}

/**
 * Format search results array.
 */
export function formatSearchResults(parsed: unknown): string {
	return formatList(parsed, (item): string => {
		const name = String(item.filename ?? item.path ?? item.name ?? "(unknown)");
		const excerpt = String(item.match ?? item.excerpt ?? "");
		return excerpt ? `${name}\n    ${excerpt.replace(/\n/g, "\n    ")}` : name;
	}, "No results found.");
}

/**
 * Format tasks list.
 */
export function formatTasks(parsed: unknown): string {
	return formatList(parsed, (t) => {
		const status = (t.status ?? t.completed ?? "") as string;
		const text = (t.text ?? t.content ?? "") as string;
		const file = (t.filename ?? t.path ?? "") as string;
		const line = (t.line ?? "") as string;
		const location = file ? (line ? `${file}:${line}` : file) : "";
		const prefix = status === " " ? "[ ]" : status === "x" ? "[x]" : `[${status}]`;
		return `${prefix} ${text}${location ? ` — ${location}` : ""}`;
	}, "No tasks found.");
}

/**
 * Format tags list.
 */
export function formatTags(parsed: unknown): string {
	return formatList(parsed, (t) => `  ${t.tag ?? t.name}: ${t.count ?? t.frequency ?? 1}`, "No tags found.");
}

/**
 * Format backlinks/links list.
 */
export function formatLinks(parsed: unknown, label = "Links"): string {
	return formatList(parsed, (l) => `  ${l.filename ?? l.path ?? l.name ?? l.link ?? "(unknown)"}`, `No ${label.toLowerCase()}.`);
}
