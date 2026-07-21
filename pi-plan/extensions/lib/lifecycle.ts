import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_SNAPSHOT_BYTES = 50 * 1024;

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


export interface RewindCheckpoint {
  promptEntryId: string;
  prompt: string;
  timestamp: string;
  baseline: string;
  cachedPatch: string;
  unstagedPatch: string;
  untrackedSnapshot: string;
  untrackedSnapshotVersion: 1;
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    );
  });
}

async function repositoryRoot(cwd: string): Promise<string> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0 || !root.stdout.trim()) throw new Error("Rewind requires a Git working tree.");
  return root.stdout.trim();
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
  cwd = await repositoryRoot(cwd);
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

export async function captureRewindCheckpoint(cwd: string, promptEntryId: string, prompt: string, timestamp = new Date().toISOString()): Promise<RewindCheckpoint> {
  const root = await repositoryRoot(cwd);
  const [head, cachedPatch, unstagedPatch, untrackedSnapshot] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["diff", "--cached", "--binary", "HEAD"]),
    git(root, ["diff", "--binary"]),
    snapshotUntrackedFiles(root),
  ]);
  if (head.code !== 0 || !/^[0-9a-f]{7,64}$/i.test(head.stdout.trim())) throw new Error("Rewind requires a Git working tree with an initial commit.");
  if (cachedPatch.code !== 0 || unstagedPatch.code !== 0) throw new Error("Could not capture the current Git patch for rewind.");
  if (Buffer.byteLength(cachedPatch.stdout, "utf8") + Buffer.byteLength(unstagedPatch.stdout, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error(`workspace patch exceeds ${MAX_SNAPSHOT_BYTES / 1024} KB; commit, stash, or reduce changes before retrying`);
  }
  return {
    promptEntryId,
    prompt,
    timestamp,
    baseline: head.stdout.trim(),
    cachedPatch: cachedPatch.stdout,
    unstagedPatch: unstagedPatch.stdout,
    untrackedSnapshot,
    untrackedSnapshotVersion: 1,
  };
}

export async function restoreRewindCheckpoint(cwd: string, checkpoint: RewindCheckpoint): Promise<{ stash: string }> {
  return restoreWorkspaceState(cwd, checkpoint);
}

export async function validateRewindCheckpoint(cwd: string, checkpoint: RewindCheckpoint): Promise<void> {
  await validateWorkspaceState(cwd, checkpoint);
}

export async function rewindToFlowBaseline(cwd: string, flow: LifecycleFlow): Promise<{ stash: string }> {
  return restoreWorkspaceState(cwd, {
    baseline: flow.baseline,
    cachedPatch: flow.initialCachedPatch ?? "",
    unstagedPatch: flow.initialUnstagedPatch ?? flow.initialDirtyPatch ?? "",
    untrackedSnapshot: flow.initialUntrackedSnapshot ?? "[]",
    untrackedSnapshotVersion: flow.initialUntrackedSnapshotVersion,
  });
}

async function validateWorkspaceState(cwd: string, state: Pick<RewindCheckpoint, "baseline">): Promise<string> {
  if (!/^[0-9a-f]{7,64}$/i.test(state.baseline)) throw new Error("No valid workflow Git baseline is available.");
  const root = await repositoryRoot(cwd);
  const exists = await git(root, ["cat-file", "-e", `${state.baseline}^{commit}`]);
  if (exists.code !== 0) throw new Error("Workflow baseline no longer exists.");
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== state.baseline) throw new Error("Rewind requires HEAD to match the checkpoint baseline; committed changes need explicit recovery.");
  return root;
}

async function restoreWorkspaceState(cwd: string, state: Pick<RewindCheckpoint, "baseline" | "cachedPatch" | "unstagedPatch" | "untrackedSnapshot"> & { untrackedSnapshotVersion?: 1 }): Promise<{ stash: string }> {
  const root = await validateWorkspaceState(cwd, state);
  const status = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
  let stash = "none";
  if (status.stdout.trim()) {
    const saved = await git(root, ["stash", "push", "--include-untracked", "-m", `pi-plan rewind ${new Date().toISOString()}`]);
    if (saved.code !== 0) throw new Error(saved.stderr.trim() || "git stash failed");
    stash = (await git(root, ["stash", "list", "-1", "--format=%gd"])).stdout.trim() || "created";
  }
  const restore = await git(root, ["restore", "--source", state.baseline, "--staged", "--worktree", "--", "."]);
  if (restore.code !== 0) throw new Error(restore.stderr.trim() || "git restore failed");
  async function applyPatch(content: string | undefined, index: boolean): Promise<void> {
    if (!content) return;
    const patch = path.join(os.tmpdir(), `pi-plan-rewind-${process.pid}-${Date.now()}-${index}.patch`);
    try {
      await writeFile(patch, content, "utf8");
      const restore = await git(root, ["apply", ...(index ? ["--index"] : []), "--whitespace=nowarn", patch]);
      if (restore.code !== 0) throw new Error(`initial dirty patch restore failed; recovery stash ${stash} is available`);
    } finally {
      await rm(patch, { force: true });
    }
  }
  await applyPatch(state.cachedPatch, true);
  await applyPatch(state.unstagedPatch, false);
  const entries = state.untrackedSnapshot ? JSON.parse(state.untrackedSnapshot) as SnapshotEntry[] : [];
  // ponytail: Git cannot stash empty directories, so leave post-checkpoint ones intact.
  for (const entry of entries.filter((entry) => entry.kind === "dir")) {
    const relative = safeRelative(root, entry.path);
    if (!relative) throw new Error("Unsafe untracked snapshot path.");
    const destination = path.join(root, relative);
    await mkdir(destination, { recursive: true });
    if (entry.mode !== undefined) await chmod(destination, entry.mode & 0o777);
  }
  for (const entry of entries.filter((entry): entry is Extract<SnapshotEntry, { kind?: "file" }> => entry.kind !== "dir")) {
    const relative = safeRelative(root, entry.path);
    if (!relative) throw new Error("Unsafe untracked snapshot path.");
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(entry.content, "base64"));
    if (entry.mode !== undefined) await chmod(destination, entry.mode & 0o777);
  }
  return { stash };
}
