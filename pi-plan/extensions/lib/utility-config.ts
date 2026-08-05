import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface UtilityConfig {
  btw: { model?: string };
  goal: { model?: string; maxTurns?: number };
  plansDir?: string;
}

type Raw = Record<string, unknown>;

async function settings(file: string): Promise<Raw> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Raw;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

function value(raw: Raw, key: string): string | undefined {
  const item = raw[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

function numberValue(raw: Raw, key: string): number | undefined {
  const item = raw[key];
  return typeof item === "number" && Number.isFinite(item) && item > 0 ? item : undefined;
}

export async function loadUtilityConfig(ctx: ExtensionContext): Promise<UtilityConfig> {
  const global = await settings(path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "settings.json"));
  const project = ctx.isProjectTrusted() ? await settings(path.join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")) : {};
  const config = { ...(global["pi-plan"] as Raw), ...(project["pi-plan"] as Raw) };
  const btw = { ...((global["pi-plan"] as Raw)?.btw as Raw), ...(config.btw as Raw) };
  const goal = { ...((global["pi-plan"] as Raw)?.goal as Raw), ...(config.goal as Raw) };
  return { btw: { model: value(btw, "model") }, goal: { model: value(goal, "model"), maxTurns: numberValue(goal, "maxTurns") }, plansDir: value(config, "plansDir") };
}

export function parseModel(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
