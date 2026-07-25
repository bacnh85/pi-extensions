// Generate the Konnect daemon config (TOML) for HTTP transport.
//
// Konnect loads config from `--config <path>` (crates/konnect/src/config.rs).
// Field names + defaults mirror that file. We only emit the fields we override;
// Konnect fills the rest from its own defaults.

import type { ResolvedConfig } from "./discovery.js";

/** Interface so the generator is testable against a literal config object. */
export interface DaemonConfig {
  transport: "http";
  httpAddress: string;
  kicadCli?: string | null;
  ipcAddress?: string | null;
  projectDir?: string | null;
  logLevel?: string;
}

/** Escape a string for a TOML basic string (also valid JSON). */
export function tomlString(s: string): string {
  return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

/** Build a DaemonConfig from a ResolvedConfig + chosen port. */
export function buildDaemonConfig(cfg: ResolvedConfig, port: number): DaemonConfig {
  return {
    transport: "http",
    httpAddress: `127.0.0.1:${port}`,
    kicadCli: cfg.kicadCli,
    ipcAddress: cfg.ipcSocket,
    projectDir: cfg.projectDir,
    logLevel: cfg.logLevel,
  };
}

/** Serialize a DaemonConfig to TOML. Omit null/undefined fields. */
export function generateKonnectToml(cfg: DaemonConfig): string {
  const lines: string[] = [];
  lines.push(`transport = ${tomlString(cfg.transport)}`);
  lines.push(`http_address = ${tomlString(cfg.httpAddress)}`);
  if (cfg.kicadCli) lines.push(`kicad_cli = ${tomlString(cfg.kicadCli)}`);
  if (cfg.ipcAddress) lines.push(`ipc_address = ${tomlString(cfg.ipcAddress)}`);
  if (cfg.projectDir) lines.push(`project_dir = ${tomlString(cfg.projectDir)}`);
  if (cfg.logLevel) lines.push(`log_level = ${tomlString(cfg.logLevel)}`);
  return lines.join("\n") + "\n";
}
