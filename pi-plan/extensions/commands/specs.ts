import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runIsolated } from "../lib/isolated-model";
import { type WorkspaceContext, workspaceContext } from "../lib/workspace-context";

const SYSTEM = `Write a compact formal technical specification in Markdown. Use exactly these headings: Intent and Scope, Exclusions, Target Files, Requirements, Assumptions and Open Questions, Acceptance Criteria. Use EARS requirements: WHEN/IF/THEN/SHALL. Every acceptance criterion MUST be independently checkable. Every existing Target Files path MUST be a file in the supplied workspace tree. If no existing file applies, write "no existing target file" and label the proposed path "new"; its parent directory MUST be in the tree. Do not invent product routes, frameworks, or directories. Do not add prose before the document.`;
const KEY = "pi-plan-specs";
const COLOR = { cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", reset: "\x1b[0m" } as const;
type ProgressColor = "cyan" | "green" | "red";

export function specSlug(intent: string): string { return intent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "spec"; }

export function formatSpecsProgress(step: string, color: ProgressColor = "cyan", now = new Date()): string {
  return `${COLOR[color]}[${now.toISOString()}] ${step}${COLOR.reset}`;
}

export function specExecutionPrompt(file: string): string {
  return `Implement the approved specification at \`${file}\`. Read it first, stay within its scope and exclusions, and verify every acceptance criterion before finishing.`;
}

/** Reject target paths that are absent from the supplied workspace context. */
export function invalidExistingTargets(context: Pick<WorkspaceContext, "files" | "directories">, content: string): string[] {
  return content.split("\n").flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].flatMap((match) => {
    const target = match[1];
    if (!(/^[.\w-]+\//.test(target) || /\.[\w-]+$/.test(target))) return [];
    const parent = path.posix.dirname(target);
    const safe = !target.includes("\\") && !path.posix.isAbsolute(target) && !path.win32.isAbsolute(target) && !target.split("/").some((part) => part === "." || part === "..");
    const proposed = /\bno existing target file\b/i.test(line) && /\bnew\b/i.test(line);
    return safe && (context.files.has(target) || proposed && context.directories.has(parent === "." ? "" : parent)) ? [] : [target];
  }));
}

async function destination(cwd: string, intent: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 7); const dir = path.join(cwd, ".agents", "specs"); await mkdir(dir, { recursive: true });
  const base = `spec-${date}-${specSlug(intent)}`;
  for (let n = 0; ; n++) { const file = path.join(dir, `${base}${n ? `-${n + 1}` : ""}.md`); try { const handle = await open(file, "wx"); await handle.close(); return file; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
}

export function registerSpecs(pi: ExtensionAPI, activate: (file: string, ctx: ExtensionContext) => Promise<void>, approve: (ctx: ExtensionContext) => Promise<string | undefined>): void {
  pi.registerCommand("specs", { description: "Compile intent into an EARS specification and lock writes", handler: async (args, ctx) => {
    const intent = args.trim(); if (!intent) return ctx.ui.notify("Usage: /specs <intent>", "warning");
    let file: string | undefined;
    const progress: string[] = [];
    const showProgress = (step: string, color: ProgressColor = "cyan") => {
      const line = formatSpecsProgress(step, color);
      progress.push(line); ctx.ui.setWidget(KEY, progress); ctx.ui.notify(line, color === "red" ? "error" : "info");
    };
    ctx.ui.setStatus(KEY, "Specs…");
    showProgress("scanning workspace");
    try {
      const context = await workspaceContext(ctx.cwd);
      showProgress("parsing context");
      showProgress("generating targets");
      const content = await runIsolated(ctx, undefined, { systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: `${context.prompt}\nINTENT\n${intent}` }], timestamp: Date.now() }] });
      showProgress("finalizing");
      const invalid = invalidExistingTargets(context, content);
      if (invalid.length) throw new Error(`Generated spec references invalid target(s): ${invalid.join(", ")}`);
      file = await destination(ctx.cwd, intent);
      await withFileMutationQueue(file, async () => { await (await import("node:fs/promises")).writeFile(file!, `${content.trim()}\n`, "utf8"); });
      await activate(file, ctx); showProgress(`specification written: ${path.relative(ctx.cwd, file)}`, "green");
    } catch (error) { if (file) await (await import("node:fs/promises")).rm(file, { force: true }); showProgress(`specification failed: ${String(error)}`, "red"); }
    finally { ctx.ui.setStatus(KEY, undefined); ctx.ui.setWidget(KEY, undefined); }
  } });
  pi.registerCommand("specs-approve", { description: "Release the active specs write gate and prefill implementation", handler: async (_args, ctx) => {
    const file = await approve(ctx);
    if (!file) return ctx.ui.notify("No active specs gate.", "warning");
    const prompt = specExecutionPrompt(path.relative(ctx.cwd, file));
    if (ctx.mode === "tui") ctx.ui.setEditorText(prompt);
    else ctx.ui.notify(prompt, "info");
  } });
}
