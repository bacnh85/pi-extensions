// Locate the Konnect binary, kicad-cli, and the KiCad IPC socket.
//
// Candidate *generation* is pure (given env/home/platform) so it is unit-tested
// without touching the filesystem. Existence checks are applied separately and
// injectable for tests.

import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type OsPlatform = NodeJS.Platform;

// ---------------------------------------------------------------------------
// Pure candidate generation
// ---------------------------------------------------------------------------

/**
 * Ordered candidate paths for the Konnect binary.
 *   1. KICAD_BINARY / KONNECT_BINARY env (explicit user override)
 *   2. PCM plugin install paths (per-OS, KiCad 10)
 *   3. release-cache fallback dir under ~/.local/share or ~/Library
 */
export function konnectBinaryCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
  plat: OsPlatform,
): string[] {
  const c: string[] = [];
  if (env.KONNECT_BINARY) c.push(env.KONNECT_BINARY);
  if (env.KICAD_BINARY) c.push(env.KICAD_BINARY);

  const ext = plat === "win32" ? ".exe" : "";
  const bin = `konnect${ext}`;
  const pluginRel = `mixelpixx_konnect/bin/${bin}`;
  // ponytail: KiCad 10 path is hard-coded; add a glob/registry scan if 9.x/11.x appear
  if (plat === "darwin") {
    c.push(`${home}/Documents/KiCad/10.0/3rdparty/plugins/com_github_${pluginRel}`);
    c.push(`${home}/Library/Application Support/konnect/${bin}`);
  } else if (plat === "win32") {
    const profile = env.USERPROFILE ?? home;
    c.push(`${profile}\\Documents\\KiCad\\10.0\\3rdparty\\plugins\\com_github_${pluginRel}`);
  } else {
    c.push(`${home}/.local/share/kicad/10.0/3rdparty/plugins/com_github_${pluginRel}`);
    c.push(`${home}/.local/share/konnect/${bin}`);
  }
  return c;
}

/** Ordered candidate paths for kicad-cli (ships with KiCad). */
export function kicadCliCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
  plat: OsPlatform,
): string[] {
  const c: string[] = [];
  if (env.KICAD_CLI) c.push(env.KICAD_CLI);
  if (plat === "darwin") {
    c.push("/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli");
  } else if (plat === "win32") {
    const pf = env.PROGRAMFILES ?? "C:\\Program Files";
    c.push(`${pf}\\KiCad\\bin\\kicad-cli.exe`);
  } else {
    c.push("/usr/bin/kicad-cli", "/usr/local/bin/kicad-cli", "/snap/kicad/current/usr/bin/kicad-cli");
  }
  return c;
}

/**
 * Resolved KiCad IPC (NNG) socket address, or null to let Konnect auto-detect
 * from the KICAD_API_SOCKET env var at runtime. We only return a value when the
 * user set one explicitly here — Konnect's own env fallback handles the rest.
 */
export function resolveIpcSocket(env: NodeJS.ProcessEnv): string | null {
  return env.KICAD_API_SOCKET && env.KICAD_API_SOCKET.length > 0
    ? env.KICAD_API_SOCKET
    : null;
}

// ---------------------------------------------------------------------------
// KiCad data directories — Konnect needs these env vars when launched
// STANDALONE (it inherits them automatically only when run as a KiCad plugin).
// Without KICAD10_SYMBOL_DIR the symbol resolver can't find ANY library, so
// add_schematic_component / get_symbol_info / search_symbols all fail while
// list_symbol_libraries (which reads sym-lib-table absolute URIs) still works.
// ---------------------------------------------------------------------------

/** Ordered candidate paths for KiCad's shared data dir (symbols/footprints/etc). */
export function kiCadSharedSupportCandidates(
  env: NodeJS.ProcessEnv,
  _home: string,
  plat: OsPlatform,
): string[] {
  if (env.KICAD_SHARED_SUPPORT) return [env.KICAD_SHARED_SUPPORT];
  if (plat === "darwin") return ["/Applications/KiCad/KiCad.app/Contents/SharedSupport"];
  if (plat === "win32") {
    const pf = env.PROGRAMFILES ?? "C:\\Program Files";
    const pfx86 = env.PROGRAMFILES_X86 ?? "C:\\Program Files (x86)";
    return [`${pf}\\KiCad\\share`, `${pfx86}\\KiCad\\share`];
  }
  return ["/usr/share/kicad", "/usr/local/share/kicad", "/snap/kicad/current/usr/share/kicad"];
}

/** Ordered candidate paths for the KiCad user data dir (KICAD_USER_DIR). */
export function kiCadUserDirCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
  plat: OsPlatform,
): string[] {
  if (env.APPDATA) return [`${env.APPDATA}/kicad`];
  if (plat === "darwin") return [`${home}/Library/Application Support/kicad`];
  if (plat === "win32") return [`${home}/AppData/Roaming/kicad`];
  return [`${home}/.local/share/kicad`];
}

/**
 * pi-kicad's managed symbol directory — the canonical place for from-scratch
 * symbols. Konnect resolves lib_id ONLY via KICAD10_SYMBOL_DIR (a single dir,
 * set at daemon start), so we always point it here. This decouples symbol
 * resolution from any KiCad project and removes the need for KICAD_PROJECT_DIR.
 * The agent creates symbols at `${managedSymbolDir}/<lib>.kicad_sym`.
 */
export function managedSymbolDir(home: string): string {
  return join(home, ".pi", "kicad-symbols");
}

// ---------------------------------------------------------------------------
// Existence resolution
// ---------------------------------------------------------------------------

export type ExistsFn = (p: string) => boolean;

export const fsExists: ExistsFn = (p) => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

export const fsExistsDir: ExistsFn = (p) => {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** First candidate that exists (and is a file), else null. */
export function resolveFirstExisting(candidates: string[], exists: ExistsFn): string | null {
  return candidates.find((c) => exists(c)) ?? null;
}

// ---------------------------------------------------------------------------
// Resolved config
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  konnectBinary: string | null;
  kicadCli: string | null;
  ipcSocket: string | null;
  httpPort: number;
  logLevel: string;
  cwd: string;
  sharedSupport: string | null;
  userDir: string | null;
  projectDir: string | null;
  symbolDir: string | null;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: OsPlatform;
  cwd?: string;
  exists?: ExistsFn;
}

/** Resolve all runtime config from env + discovery. Pure-ish (defaults to real FS). */
export function resolveConfig(opts: ResolveOptions = {}): ResolvedConfig {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const plat = opts.platform ?? platform();
  const cwd = opts.cwd ?? process.cwd();
  const exists = opts.exists ?? fsExists;

  const projectDir = env.KICAD_PROJECT_DIR && env.KICAD_PROJECT_DIR.length > 0 ? env.KICAD_PROJECT_DIR : null;
  const sharedSupport = resolveFirstExisting(kiCadSharedSupportCandidates(env, home, plat), fsExistsDir);
  // KICAD10_SYMBOL_DIR drives Konnect's ONLY library-resolution path (it ignores
  // the sym-lib-table). Always use the managed dir so from-scratch symbols
  // resolve without any project/env coupling; an explicit env wins.
  const symbolDir =
    env.KICAD10_SYMBOL_DIR && env.KICAD10_SYMBOL_DIR.length > 0
      ? env.KICAD10_SYMBOL_DIR
      : managedSymbolDir(home);

  return {
    konnectBinary: resolveFirstExisting(konnectBinaryCandidates(env, home, plat), exists),
    kicadCli: resolveFirstExisting(kicadCliCandidates(env, home, plat), exists),
    ipcSocket: resolveIpcSocket(env),
    httpPort: parseInt(env.KICAD_HTTP_PORT ?? "", 10) || DEFAULT_HTTP_PORT,
    logLevel: env.KICAD_LOG_LEVEL ?? "info",
    cwd,
    sharedSupport,
    userDir: resolveFirstExisting(kiCadUserDirCandidates(env, home, plat), fsExistsDir),
    projectDir,
    symbolDir,
  };
}

export const DEFAULT_HTTP_PORT = 31337;

/**
 * Build KiCad environment variables (KICAD10_SYMBOL_DIR, …) for the daemon's
 * spawn env, pointing at the discovered shared-data subdirs + user dir. Only
 * emits a var when its target dir exists, so we never point Konnect at a
 * non-existent path. `exists` is injectable for tests.
 */
export function buildKiCadEnv(cfg: ResolvedConfig, exists: ExistsFn = fsExistsDir): Record<string, string> {
  const env: Record<string, string> = {};
  // Symbol dir: the project dir (custom from-scratch symbols) wins over KiCad's
  // shared symbols, which Konnect's parser can't read anyway.
  if (cfg.symbolDir) env.KICAD10_SYMBOL_DIR = cfg.symbolDir;
  const sub = (name: string, varName: string): void => {
    if (cfg.sharedSupport && exists(join(cfg.sharedSupport, name))) {
      env[varName] = join(cfg.sharedSupport, name);
    }
  };
  sub("footprints", "KICAD10_FOOTPRINT_DIR");
  sub("template", "KICAD10_TEMPLATE_DIR");
  sub("3dmodels", "KICAD10_3DMODEL_DIR");
  if (cfg.userDir) env.KICAD_USER_DIR = cfg.userDir;
  return env;
}
