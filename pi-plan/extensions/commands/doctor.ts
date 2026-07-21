import { access, constants, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function check(file: string): Promise<string> {
  try { await access(file, constants.R_OK | constants.W_OK); return "ok"; } catch { return "warn"; }
}
function engine(range: unknown): string {
  if (typeof range !== "string") return "info";
  const match = range.match(/^>=\s*(\d+)/); return match ? (Number(process.versions.node.split(".")[0]) >= Number(match[1]) ? "ok" : "fail") : "info";
}

export function registerDoctor(pi: ExtensionAPI): void {
  pi.registerCommand("doctor", { description: "Check workspace and Pi runtime health", handler: async (_args, ctx) => {
    const dirs = await Promise.all([".agents", ".agents/plans", ".agents/specs"].map(async (name) => `${await check(path.join(ctx.cwd, name))} ${name}`));
    const git = await pi.exec("git", ["status", "--porcelain"], { timeout: 5_000 });
    let manifest: Record<string, unknown> = {}; try { manifest = JSON.parse(await readFile(path.join(ctx.cwd, "package.json"), "utf8")); } catch { /* optional */ }
    const available = ctx.modelRegistry.getAvailable().length; const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
    const lines = [
      "doctor", ...dirs, `${git.code === 0 ? "ok" : "warn"} git${git.code === 0 ? (git.stdout.trim() ? " dirty" : " clean") : " unavailable"}`,
      `${engine((manifest.engines as Record<string, unknown> | undefined)?.node)} node ${process.versions.node}${(manifest.engines as Record<string, unknown> | undefined)?.node ? ` (${(manifest.engines as Record<string, unknown>).node})` : ""}`,
      `${available ? "ok" : "warn"} models ${available}; active ${active}`, `ok tools ${pi.getActiveTools().length}`,
    ];
    ctx.ui.setWidget("pi-plan-doctor", lines); ctx.ui.notify(lines.join(" · "), git.code === 0 ? "info" : "warning");
  } });
}
