import { execObsidian } from "./cli";

// ---------------------------------------------------------------------------
// Higher-level operations built on the Obsidian CLI
// ---------------------------------------------------------------------------

/** Recursively list all files under a folder. */
export function listFilesRecursive(folder: string, vault?: string, timeoutMs = 30_000): string[] {
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push(`files`, `folder=${folder}`, `format=json`);
	const r = execObsidian(args, false, timeoutMs);
	if (!r.parsed || !Array.isArray(r.parsed)) return [];
	return r.parsed as string[];
}

/** Get file content by wikilink name. */
export function readNote(name: string, vault?: string, timeoutMs = 30_000): string {
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push(`read`, `file=${name}`);
	const r = execObsidian(args, false, timeoutMs);
	return r.stdout.trim();
}

/** Get file content by exact path. */
export function readNoteByPath(path: string, vault?: string, timeoutMs = 30_000): string {
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push(`read`, `path=${path}`);
	const r = execObsidian(args, false, timeoutMs);
	return r.stdout.trim();
}

/** Create a task line in a note under a specific heading. */
export function createTask(notePath: string, heading: string, taskText: string, vault?: string, timeoutMs = 30_000): string {
	// First read the note content to find the heading
	const content = readNoteByPath(notePath, vault, timeoutMs);
	const lines = content.split("\n");

	// Find the heading and the end of its section
	let headingIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith("#") && trimmed.replace(/^#+\s*/, "") === heading) {
			headingIdx = i;
			break;
		}
	}

	if (headingIdx === -1) {
		// No heading found, append to end
		const newContent = content.endsWith("\n") ? content : content + "\n";
		const args: string[] = [];
		if (vault) args.push(`vault=${vault}`);
		const taskLine = `\n## ${heading}\n- [ ] ${taskText}\n`;
		args.push(`append`, `path=${notePath}`, `content=${escapeContent(taskLine)}`);
		execObsidian(args, false, timeoutMs);
		return `Created heading "${heading}" and added task.`;
	}

	// Find the next heading at same or higher level, or end of file
	const headingLevel = lines[headingIdx].match(/^(#+)/)?.[1].length ?? 2;
	let sectionEnd = lines.length;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		const match = lines[i].match(/^(#+)\s/);
		if (match && match[1].length <= headingLevel) {
			sectionEnd = i;
			break;
		}
	}

	// Insert task line before section end
	const taskLine = `- [ ] ${taskText}`;
	const before = lines.slice(headingIdx + 1, sectionEnd);
	if (before.some(l => l.trim() === "" || l.trim().startsWith("- [ ]"))) {
		// There's already content — append after the heading section content
		lines.splice(sectionEnd, 0, taskLine);
	} else {
		// Empty heading section — add the task
		lines.splice(headingIdx + 1, 0, "", taskLine);
	}

	// Write back the full file
	const newContent = lines.join("\n");
	const args: string[] = [];
	if (vault) args.push(`vault=${vault}`);
	args.push(`create`, `path=${notePath}`, `overwrite=true`, `content=${escapeContent(newContent)}`);
	execObsidian(args, false, timeoutMs);
	return `Added task "${taskText}" under heading "${heading}".`;
}

function escapeContent(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t");
}

/** Group tasks by source file, optionally filtered by search query. */
export function groupTasksByFile(parsed: unknown, filterStatus?: "open" | "done" | "all"): string {
	if (!parsed || !Array.isArray(parsed) || parsed.length === 0) return "No tasks found.";

	type Task = {
		status?: string;
		text?: string;
		content?: string;
		filename?: string;
		path?: string;
		line?: number;
		completed?: boolean;
	};

	const groups = new Map<string, Task[]>();
	for (const t of parsed as Record<string, unknown>[]) {
		const file = (t.filename ?? t.path ?? "(unknown)") as string;
		if (!groups.has(file)) groups.set(file, []);
		groups.get(file)!.push(t as Task);
	}

	const lines: string[] = [];
	for (const [file, tasks] of [...groups.entries()].sort()) {
		const filtered = filterStatus && filterStatus !== "all"
			? tasks.filter(t => {
					const isDone = t.status === "x" || t.completed === true;
					return filterStatus === "done" ? isDone : !isDone;
			  })
			: tasks;
		if (filtered.length === 0) continue;

		lines.push(`\n## ${file}`);
		for (const t of filtered) {
			const status = t.status ?? (t.completed ? "x" : " ") as string;
			const text = (t.text ?? t.content ?? "") as string;
			const line = t.line ?? "";
			const location = line ? `:${line}` : "";
			const prefix = status === " " ? "[ ]" : status === "x" ? "[x]" : `[${status}]`;
			lines.push(`${prefix} ${text}${location}`);
		}
	}

	return lines.length === 0 ? "No tasks found matching filter." : lines.join("\n");
}
