import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rmdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_SNAPSHOT_BYTES = 50 * 1024;
const HANDOFF_FILE = ".pi-handoff.md";

type SnapshotEntry =
	| { path: string; hash: string; content: string; mode?: number; kind?: "file" }
	| { path: string; mode?: number; kind: "dir" };

export interface LifecycleFlow {
	baseline: string;
	initialDirty?: string;
	initialDirtyPatch?: string;
	initialCachedPatch?: string;
	initialUnstagedPatch?: string;
	initialUntrackedSnapshot?: string;
	initialUntrackedSnapshotVersion?: 1;
	phase: string;
	reviewPass: number;
	verificationSummary?: string;
	blockingFindings?: Array<{ issue: string; evidence: string }>;
}

export interface LifecycleState {
	lastPlanPath?: string;
	lastPlanTitle?: string;
	lastPlanStatus?: string;
	flow?: LifecycleFlow;
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) =>
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
		);
	});
}

function clip(value: string | undefined, max = 400): string {
	const text = value?.trim().replace(/\s+/g, " ") || "-";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function planMilestones(content: string): { done: string; next: string } {
	const lines = content.split("\n").map((line) => line.trim()).filter(Boolean);
	const done = lines.filter((line) => /^[-*]\s+\[[xX]\]/.test(line)).slice(0, 6).map((line) => line.replace(/^[-*]\s+\[[xX]\]\s*/, ""));
	const next = lines.filter((line) => /^(?:[-*]\s+\[ \]|\d+[.)])\s+/.test(line) && !/^[-*]\s+\[[xX]\]/.test(line)).slice(0, 3).map((line) => line.replace(/^(?:[-*]\s+\[ \]|\d+[.)])\s+/, ""));
	return { done: done.join(" | ") || "-", next: next.join(" | ") || "-" };
}

function safeRelative(cwd: string, file: string): string | undefined {
	const resolved = path.resolve(cwd, file);
	const relative = path.relative(cwd, resolved);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined;
}

async function emptyDirectories(cwd: string, relative = ""): Promise<{ entries: SnapshotEntry[]; empty: boolean }> {
	if (relative && (await git(cwd, ["check-ignore", "-q", "--", relative])).code === 0) return { entries: [], empty: false };
	const directory = path.join(cwd, relative);
	const children = await readdir(directory, { withFileTypes: true });
	const entries: SnapshotEntry[] = [];
	let empty = true;
	for (const child of children) {
		if (child.name === ".git") continue;
		if (!child.isDirectory()) {
			empty = false;
			continue;
		}
		const nested = await emptyDirectories(cwd, path.join(relative, child.name));
		entries.push(...nested.entries);
		if (!nested.empty) empty = false;
	}
	if (!relative || !empty) return { entries, empty };
	const stat = await lstat(directory);
	entries.push({ path: relative, mode: stat.mode & 0o777, kind: "dir" });
	return { entries, empty: true };
}

/** Snapshot untracked files and empty directories losslessly; callers own mutation serialization. */
export async function snapshotUntrackedFiles(cwd: string): Promise<string> {
	const result = await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
	const files = result.stdout.split("\0").filter(Boolean);
	let totalBytes = 0;
	const entries: SnapshotEntry[] = [];
	for (const file of files) {
		const filePath = path.join(cwd, file);
		let handle;
		try {
			handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`untracked path is not a regular file: ${file}`);
			throw error;
		}
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) throw new Error(`untracked path is not a regular file: ${file}`);
			const remaining = MAX_SNAPSHOT_BYTES - totalBytes;
			const buffer = Buffer.allocUnsafe(remaining + 1);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
				if (!result.bytesRead) break;
				bytesRead += result.bytesRead;
			}
			if (bytesRead > remaining) throw new Error(`untracked content exceeds ${MAX_SNAPSHOT_BYTES / 1024} KB; commit, stage, or ignore unrelated untracked files before retrying`);
			const content = buffer.subarray(0, bytesRead);
			totalBytes += content.length;
			entries.push({ path: file, hash: createHash("sha256").update(content).digest("hex"), content: content.toString("base64"), mode: stat.mode & 0o777, kind: "file" });
		} finally {
			await handle.close();
		}
	}
	const directories = new Map<string, Extract<SnapshotEntry, { kind: "dir" }>>();
	for (const entry of entries) {
		for (let directory = path.dirname(entry.path); directory !== "."; directory = path.dirname(directory)) {
			if (directories.has(directory)) continue;
			const stat = await lstat(path.join(cwd, directory));
			directories.set(directory, { path: directory, mode: stat.mode & 0o777, kind: "dir" });
		}
	}
	for (const directory of (await emptyDirectories(cwd)).entries) {
		if (directory.kind === "dir") directories.set(directory.path, directory);
	}
	return JSON.stringify([...entries, ...directories.values()]);
}

export async function createHandoff(cwd: string, state: LifecycleState): Promise<{ path: string; snippet: string }> {
	const [root, status, files] = await Promise.all([
		git(cwd, ["rev-parse", "--show-toplevel"]),
		git(cwd, ["status", "--porcelain"]),
		git(cwd, ["diff", "--name-only", "HEAD"]),
	]);
	let plan = "";
	if (state.lastPlanPath && safeRelative(cwd, state.lastPlanPath)) plan = await readFile(state.lastPlanPath, "utf8").catch(() => "");
	const milestones = planMilestones(plan);
	const active = [...new Set(`${files.stdout}\n${status.stdout}`.split("\n").map((line) => line.trim().replace(/^(?:[ MADRCU?!]{2}\s+)?/, "")).filter(Boolean))].slice(0, 12).join(" | ") || "-";
	const errors = state.flow?.blockingFindings?.slice(0, 3).map((finding) => clip(`${finding.issue}: ${finding.evidence}`, 240)).join(" | ") || clip(state.flow?.verificationSummary);
	const content = [
		"# pi-plan handoff",
		`plan: ${clip(state.lastPlanTitle)} (${clip(state.lastPlanStatus)})`,
		`flow: ${state.flow ? `${state.flow.phase}/${state.flow.reviewPass} base=${state.flow.baseline}` : "-"}`,
		`done: ${milestones.done}`,
		`next: ${milestones.next}`,
		`files: ${active}`,
		"stack: @bacnh85/pi-plan · TypeScript · Node · Git",
		`errors: ${errors}`,
		`git: ${root.code === 0 ? `root=${path.basename(root.stdout.trim())} dirty=${status.stdout.trim() ? "yes" : "no"}` : "unavailable"}`,
		"resume: Read .pi-handoff.md; continue the next milestone; verify before changing state.",
		"",
	].join("\n");
	const destination = path.join(cwd, HANDOFF_FILE);
	await writeFile(destination, content, "utf8");
	return { path: destination, snippet: "Read .pi-handoff.md; continue the next milestone." };
}

export async function rewindToFlowBaseline(cwd: string, flow: LifecycleFlow): Promise<{ stash: string }> {
	if (!/^[0-9a-f]{7,64}$/i.test(flow.baseline)) throw new Error("No valid workflow Git baseline is available.");
	const repo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repo.code !== 0 || repo.stdout.trim() !== "true") throw new Error("Rewind requires a Git working tree.");
	const exists = await git(cwd, ["cat-file", "-e", `${flow.baseline}^{commit}`]);
	if (exists.code !== 0) throw new Error("Workflow baseline no longer exists.");
	const head = await git(cwd, ["rev-parse", "HEAD"]);
	if (head.code !== 0 || head.stdout.trim() !== flow.baseline) throw new Error("Rewind requires HEAD to match the workflow baseline; committed workflow changes need explicit recovery.");

	const status = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
	if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
	let stash = "none";
	if (status.stdout.trim()) {
		const saved = await git(cwd, ["stash", "push", "--include-untracked", "-m", `pi-plan rewind ${new Date().toISOString()}`]);
		if (saved.code !== 0) throw new Error(saved.stderr.trim() || "git stash failed");
		stash = (await git(cwd, ["stash", "list", "-1", "--format=%gd"])).stdout.trim() || "created";
	}
	const restore = await git(cwd, ["restore", "--source", flow.baseline, "--staged", "--worktree", "--", "."]);
	if (restore.code !== 0) throw new Error(restore.stderr.trim() || "git restore failed");
	async function applyPatch(content: string | undefined, index: boolean): Promise<void> {
		if (!content) return;
		const patch = path.join(os.tmpdir(), `pi-plan-rewind-${process.pid}-${Date.now()}-${index}.patch`);
		try {
			await writeFile(patch, content, "utf8");
			const restore = await git(cwd, ["apply", ...(index ? ["--index"] : []), "--whitespace=nowarn", patch]);
			if (restore.code !== 0) throw new Error(`initial dirty patch restore failed; recovery stash ${stash} is available`);
		} finally {
			await rm(patch, { force: true });
		}
	}
	if (flow.initialCachedPatch || flow.initialUnstagedPatch) {
		await applyPatch(flow.initialCachedPatch, true);
		await applyPatch(flow.initialUnstagedPatch, false);
	} else {
		await applyPatch(flow.initialDirtyPatch, false);
	}
	const entries = flow.initialUntrackedSnapshot ? JSON.parse(flow.initialUntrackedSnapshot) as SnapshotEntry[] : [];
	if (flow.initialUntrackedSnapshotVersion === 1 || entries.some((entry) => entry.kind !== undefined)) {
		const initialDirectories = new Set(entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path));
		for (const entry of (await emptyDirectories(cwd)).entries) {
			if (initialDirectories.has(entry.path)) continue;
			try {
				await rmdir(path.join(cwd, entry.path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	}
	for (const entry of entries.filter((entry) => entry.kind === "dir")) {
		const relative = safeRelative(cwd, entry.path);
		if (!relative) throw new Error("Unsafe untracked snapshot path.");
		const destination = path.join(cwd, relative);
		await mkdir(destination, { recursive: true });
		if (entry.mode !== undefined) await chmod(destination, entry.mode & 0o777);
	}
	for (const entry of entries.filter((entry): entry is Extract<SnapshotEntry, { kind?: "file" }> => entry.kind !== "dir")) {
		const relative = safeRelative(cwd, entry.path);
		if (!relative) throw new Error("Unsafe untracked snapshot path.");
		const destination = path.join(cwd, relative);
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, Buffer.from(entry.content, "base64"));
		if (entry.mode !== undefined) await chmod(destination, entry.mode & 0o777);
	}
	return { stash };
}
