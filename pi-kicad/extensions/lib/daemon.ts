// KonnectDaemon — spawn and manage the Konnect binary in HTTP mode.
//
// One daemon per Pi process (module singleton via getDaemon()). On ensure():
//   1. reuse the daemon we spawned this session if still healthy
//   2. otherwise pick a free port, write a temp TOML, spawn
//      `konnect --config <toml>`, poll GET /health until "ok" or timeout
// A stranger daemon already on the preferred port is never reused (stale-env
// risk); pickFreePort avoids it and we spawn our own.
// The child is killed on process exit. Stderr is captured so a startup failure
// surfaces a useful message instead of a bare timeout.
//   // ponytail: single global daemon, non-detached (dies with Pi on exit kill);
//   //   detached + pidfile reuse across Pi restarts if ever needed.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
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

export function buildSpawnArgs(configPath: string): string[] {
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
  mkdir?: (path: string) => Promise<void>;
  tmpdir?: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  mkdtemp?: (prefix: string) => Promise<string>;
}

export interface DaemonStatus {
  running: boolean;
  healthy: boolean;
  port: number | null;
  pid: number | null;
  startedAt: number | null;
  config: ResolvedConfig;
}

export class KonnectDaemon {
  private config: ResolvedConfig;
  private deps: Required<DaemonDeps>;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private ensureP: Promise<number> | null = null;
  private startedAt: number | null = null;
  private stderrTail = "";
  private cfgDir: string | null = null;
  private exitHandlerBound = false;
  // Stable handler refs so stop() can unbind — without this, every discarded
  // instance (a discarded daemon) leaks a full set of process handlers, since
  // exitHandlerBound is per-instance.
  private exitCleanup = (): void => this.killChild();
  private onSigint = (): void => {
    this.exitCleanup();
    if (process.listenerCount("SIGINT") === 0) process.exit(130);
  };
  private onSigterm = (): void => {
    this.exitCleanup();
    if (process.listenerCount("SIGTERM") === 0) process.exit(143);
  };

  constructor(resolveOpts: ResolveOptions = {}, deps: DaemonDeps = {}) {
    this.config = resolveConfig(resolveOpts);
    this.deps = {
      fetchImpl: deps.fetchImpl ?? fetch,
      spawnImpl: deps.spawnImpl ?? spawn,
      writeFile: deps.writeFile ?? ((p, d) => writeFile(p, d, "utf8")),
      mkdir: deps.mkdir ?? (async (p) => { await mkdir(p, { recursive: true }); }),
      tmpdir: deps.tmpdir ?? tmpdir,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      mkdtemp: deps.mkdtemp ?? ((prefix) => mkdtemp(prefix)),
    };
  }

  getResolvedConfig(): ResolvedConfig {
    return this.config;
  }

  /** Ensure a healthy daemon is running; return its port. Idempotent. */
  async ensure(): Promise<number> {
    // Reuse only a daemon WE spawned this session. We never reuse a stranger
    // daemon on the preferred port: it may be stale (e.g. from a prior Pi
    // session with different env) and we can't restart it. pickFreePort avoids
    // it and we spawn our own with the correct environment.
    if (this.child && this.port !== null && (await this.isHealthy())) {
      return this.port;
    }
    // Memoize the in-flight spawn so two parallel ensure() calls (e.g. two
    // kicad_calls at session start) share one daemon instead of both passing
    // the falsy-child check above and orphaning the first spawn.
    this.ensureP ??= this.spawn();
    try {
      const port = await this.ensureP;
      this.ensureP = null; // memo covers only the in-flight window
      return port;
    } catch (err) {
      this.ensureP = null;
      throw err;
    }
  }

  private async spawn(): Promise<number> {
    // Respawn after a mid-session crash: drop the previous daemon's config dir
    // before mkdtemp'ing a fresh one, or the old pi-kicad-daemon-* dir leaks.
    if (this.cfgDir) {
      try { rmSync(this.cfgDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      this.cfgDir = null;
    }
    if (!this.config.konnectBinary) {
      throw new Error(
        "Konnect binary not found. Install it via the KiCad 10 Plugin and Content Manager " +
          "(konnect-pcm zip) or a GitHub release, or set KONNECT_BINARY. " +
          "On macOS, clear quarantine on a browser download: xattr -d com.apple.quarantine ./konnect",
      );
    }
    // Ensure the managed symbol dir exists so create_symbol calls can write here.
    if (this.config.symbolDir) await this.deps.mkdir(this.config.symbolDir).catch(() => {});
    const port = await pickFreePort(this.config.httpPort);
    const daemonCfg = buildDaemonConfig(this.config, port);
    const toml = generateKonnectToml(daemonCfg);
    // Private dir via mkdtemp (issue #20 L1): a predictable flat tmpdir filename
    // is a symlink-clobber target on multi-user hosts. mkdtemp gives us an
    // unpredictable, 0o700 directory — no O_EXCL dance needed.
    const cfgDir = await this.deps.mkdtemp(join(this.deps.tmpdir(), "pi-kicad-daemon-"));
    this.cfgDir = cfgDir;
    const configPath = join(cfgDir, `daemon-${port}.toml`);
    await this.deps.writeFile(configPath, toml);

    this.stderrTail = "";
    this.child = this.deps.spawnImpl(this.config.konnectBinary, buildSpawnArgs(configPath), {
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
        const message = `Konnect exited (code ${this.child.exitCode}) before becoming healthy.\n${this.stderrTail}`;
        // Reap like the timeout path below: leaving the dead child set would
        // report running:true and orphan this.cfgDir on the next ensure().
        this.killChild();
        throw new Error(message);
      }
      if (await probeHealth(port, { fetchImpl: this.deps.fetchImpl, timeoutMs: 1000 })) {
        this.port = port;
        this.startedAt = this.deps.now();
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
      running: this.child !== null,
      healthy,
      port: this.port,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      config: this.config,
    };
  }

  /** Restart: stop (if we own it) then ensure again. */
  async restart(): Promise<number> {
    this.killChild();
    this.port = null;
    return this.ensure();
  }

  stop(): void {
    this.killChild();
    this.unbindExitHandler();
  }

  private killChild(): void {
    // Allow a later ensure() to respawn: any in-flight spawn memo is stale
    // once we tear the child down. stop()/restart()/crash paths all route
    // through here.
    this.ensureP = null;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already dead */
      }
      this.child = null;
    }
    if (this.cfgDir) {
      try {
        rmSync(this.cfgDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      this.cfgDir = null;
    }
  }

  private bindExitHandler(): void {
    if (this.exitHandlerBound) return;
    this.exitHandlerBound = true;
    // 'exit' covers normal and host-managed shutdown paths. A once() SIGINT/
    // SIGTERM handler REPLACES the default terminator, so when we are the only
    // listener the handler must terminate explicitly after cleanup — otherwise
    // the first Ctrl+C (print/RPC modes: pi's host registers no persistent
    // SIGINT handler) leaves the host alive with a dead daemon and the handler
    // disarmed. When another listener owns the signal (pi's interactive host
    // prepends a SIGTERM shutdown handler and guards SIGINT while suspended),
    // that handler's shutdown path fires 'exit' → cleanup, so exiting here
    // would cut its graceful shutdown short — defer instead. 130/143 =
    // 128+signal convention. killChild is idempotent, so signal-then-exit
    // double-runs are harmless.
    process.once("exit", this.exitCleanup);
    process.once("SIGINT", this.onSigint);
    process.once("SIGTERM", this.onSigterm);
  }

  // removeListener matches a once-wrapper via the original function too, so
  // passing the fields removes the wrappers registered in bindExitHandler.
  private unbindExitHandler(): void {
    if (!this.exitHandlerBound) return;
    this.exitHandlerBound = false;
    process.removeListener("exit", this.exitCleanup);
    process.removeListener("SIGINT", this.onSigint);
    process.removeListener("SIGTERM", this.onSigterm);
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

export type { DaemonConfig };
export { DEFAULT_HTTP_PORT };
