import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "target"]);
const MANIFESTS = new Set(["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "composer.json"]);
const MAX = 24_000;

export interface WorkspaceContext {
  prompt: string;
  files: Set<string>;
  directories: Set<string>;
}

async function safeRead(file: string): Promise<string> {
  try { return (await readFile(file, "utf8")).slice(0, 4_000); } catch { return ""; }
}

export async function workspaceContext(cwd: string, activePlan?: string): Promise<WorkspaceContext> {
  const tree: string[] = [];
  const manifests: string[] = [];
  const files = new Set<string>();
  const directories = new Set<string>([""]);
  async function walk(dir: string, prefix = "", depth = 0): Promise<void> {
    if (depth > 3 || tree.join("\n").length > 8_000) return;
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (tree.length >= 400 || tree.join("\n").length > 8_000) return;
      if (SKIP.has(entry.name)) continue;
      const relative = `${prefix}${entry.name}`;
      tree.push(`${relative}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isFile()) files.add(relative);
      if (entry.isDirectory()) directories.add(relative);
      const file = path.join(dir, entry.name);
      if (entry.isFile() && MANIFESTS.has(entry.name)) manifests.push(`${relative}\n${await safeRead(file)}`);
      if (entry.isDirectory()) await walk(file, `${relative}/`, depth + 1);
    }
  }
  await walk(cwd);
  let plan = "none";
  if (activePlan && path.relative(cwd, activePlan).split(path.sep)[0] === ".agents") plan = await safeRead(activePlan) || "none";
  if (plan === "none") {
    const dir = path.join(cwd, ".agents", "plans");
    try {
      const candidates = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".md")).map(async (name) => ({ name, time: (await stat(path.join(dir, name))).mtimeMs })));
      const latest = candidates.sort((a, b) => b.time - a.time)[0];
      if (latest) plan = await safeRead(path.join(dir, latest.name)) || "none";
    } catch { /* optional */ }
  }
  return {
    prompt: `TREE\n${tree.join("\n")}\nMANIFESTS\n${manifests.join("\n---\n") || "none"}\nPLAN\n${plan}`.slice(0, MAX),
    files,
    directories,
  };
}
