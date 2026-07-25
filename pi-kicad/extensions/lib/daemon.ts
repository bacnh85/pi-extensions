// KonnectDaemon — spawn and manage the Konnect binary in HTTP mode.
//
// One daemon per Pi process (module singleton via getDaemon()). On ensure():
//   1. reuse if already running + healthy
//   2. reuse a healthy daemon already on the preferred port
//   3. pick a free port, write a temp TOML, spawn `konnect --config <toml>`,
//      poll GET /health until "ok" or timeout
// The child is killed on process exit. Stderr is captured so a startup failure
// surfaces a useful message instead of a bare timeout.
//   // ponytail: single global daemon, non-detached (dies with Pi on exit kill);
//   //   detached + pidfile reuse across Pi restarts if ever needed.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  buildDaemonConfig,
  generateKonnectToml,
  type DaemonConfig,
} from "./config.js";
import {
  resolveConfig,
  buildKiCadEnv,
  type ResolvedConfig,
  type ResolveOptions,
  DEFAULT_HTTP_PORT,
} from "./discovery.js";
import { probeHealth } from "./konnect-client.js";

export const STARTUP_TIMEOUT_MS = 15_000;
export const HEALTH_POLL_INTERVAL_MS = 200;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function buildSpawnArgs(binary: string, configPath: string): string[] {
  return ["--config", configPath];
}

/** Pick a free port: try preferred, fall back to an OS-assigned one. */
export function pickFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number | undefined) => {
      const server = createServer();
      server.unref();
      server.on("error", (err) => {
        if (port !== undefined && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          tryListen(undefined); // fall back to random
        } else {
          reject(err);
        }
      });
      server.listen(port ?? 0, "127.0.0.1", () => {
        const addr = server.address();
        const got = addr && typeof addr === "object" ? addr.port : preferred;
        server.close(() => resolve(got));
      });
    };
    tryListen(preferred);
  });
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export interface DaemonDeps {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  writeFile?: (path: string, data: string) => Promise<void>;
  tmpdir?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DaemonStatus {
  running: boolean;
  healthy: boolean;
  port: number | null;
  pid: number | null;
  startedAt: number | null;
  reused: boolean;
  config: ResolvedConfig;
}

export class KonnectDaemon {
  private config: ResolvedConfig;
  private deps: Required<DaemonDeps>;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private startedAt: number | null = null;
  private reused = false;
  private stderrTail = "";
  private exitHandlerBound = false;

  constructor(resolveOpts: ResolveOptions = {}, deps: DaemonDeps = {}) {
    this.config = resolveConfig(resolveOpts);
    this.deps = {
      fetchImpl: deps.fetchImpl ?? fetch,
      spawnImpl: deps.spawnImpl ?? spawn,
      writeFile: deps.writeFile ?? ((p, d) => writeFile(p, d, "utf8")),
      tmpdir: deps.tmpdir ?? tmpdir,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  getResolvedConfig(): ResolvedConfig {
    return this.config;
  }

  /** Ensure a healthy daemon is running; return its port. Idempotent. */
  async ensure(): Promise<number> {
    // 1. Already running and healthy?
    if (this.child && this.port !== null && (await this.isHealthy())) {
      return this.port;
    }
    // 2. Healthy daemon already on the preferred port? Reuse it.
    if (await probeHealth(this.config.httpPort, { fetchImpl: this.deps.fetchImpl, timeoutMs: 800 })) {
      this.port = this.config.httpPort;
      this.reused = true;
      this.startedAt = this.deps.now();
      this.child = null;
      return this.port;
    }
    // 3. Spawn our own.
    return this.spawn();
  }

  private async spawn(): Promise<number> {
    if (!this.config.konnectBinary) {
      throw new Error(
        "Konnect binary not found. Install it via the KiCad 10 Plugin and Content Manager " +
          "(konnect-pcm zip) or a GitHub release, or set KONNECT_BINARY. " +
          "On macOS, clear quarantine on a browser download: xattr -d com.apple.quarantine ./konnect",
      );
    }
    const port = await pickFreePort(this.config.httpPort);
    const daemonCfg = buildDaemonConfig(this.config, port);
    const toml = generateKonnectToml(daemonCfg);
    // Flat file in tmpdir — no subdir/mkdir needed (Konnect only needs the file).
    const configPath = join(this.deps.tmpdir(), `pi-kicad-daemon-${port}.toml`);
    await this.deps.writeFile(configPath, toml);

    this.stderrTail = "";
    this.child = this.deps.spawnImpl(this.config.konnectBinary, buildSpawnArgs(this.config.konnectBinary, configPath), {
      stdio: ["ignore", "ignore", "pipe"],
      // Standalone Konnect doesn't inherit KiCad's data-dir env vars the way a
      // plugin-mode launch would; provide them so the symbol resolver works.
      env: { ...process.env, ...buildKiCadEnv(this.config) },
    });
    if (this.child.stderr) {
      this.child.stderr.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
      });
    }
    this.bindExitHandler();

    // Poll health until ready or timeout.
    const deadline = this.deps.now() + STARTUP_TIMEOUT_MS;
    while (this.deps.now() < deadline) {
      if (this.child.exitCode !== null || this.child.signalCode) {
        throw new Error(`Konnect exited (code ${this.child.exitCode}) before becoming healthy.\n${this.stderrTail}`);
      }
      if (await probeHealth(port, { fetchImpl: this.deps.fetchImpl, timeoutMs: 1000 })) {
        this.port = port;
        this.startedAt = this.deps.now();
        this.reused = false;
        return port;
      }
      await this.deps.sleep(HEALTH_POLL_INTERVAL_MS);
    }
    this.killChild();
    throw new Error(`Konnect did not become healthy within ${STARTUP_TIMEOUT_MS}ms on port ${port}.\n${this.stderrTail}`);
  }

  async isHealthy(): Promise<boolean> {
    if (this.port === null) return false;
    return probeHealth(this.port, { fetchImpl: this.deps.fetchImpl, timeoutMs: 1500 });
  }

  getPort(): number | null {
    return this.port;
  }

  async getStatus(): Promise<DaemonStatus> {
    const healthy = this.port !== null && (await this.isHealthy());
    return {
      running: this.child !== null || this.reused,
      healthy,
      port: this.port,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      reused: this.reused,
      config: this.config,
    };
  }

  /** Restart: stop (if we own it) then ensure again. */
  async restart(): Promise<number> {
    this.killChild();
    this.port = null;
    this.reused = false;
    return this.ensure();
  }

  stop(): void {
    this.killChild();
  }

  private killChild(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already dead */
      }
      this.child = null;
    }
  }

  private bindExitHandler(): void {
    if (this.exitHandlerBound) return;
    this.exitHandlerBound = true;
    // Best-effort cleanup. beforeExit/exit fire on normal termination; a hard
    // crash leaves the daemon running, which a later session reuses via health.
    process.once("exit", () => this.killChild());
  }
}

// ---------------------------------------------------------------------------
// Module singleton
// ---------------------------------------------------------------------------

let _daemon: KonnectDaemon | null = null;

export function getDaemon(): KonnectDaemon {
  if (!_daemon) _daemon = new KonnectDaemon();
  return _daemon;
}

export function _resetDaemon(): void {
  _daemon = null;
}

export type { DaemonConfig };
export { DEFAULT_HTTP_PORT };
