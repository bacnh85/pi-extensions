import { assert } from "chai";
import { EventEmitter } from "node:events";
import {
  buildSpawnArgs,
  pickFreePort,
  KonnectDaemon,
  STARTUP_TIMEOUT_MS,
} from "../lib/daemon.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeChild {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderr: EventEmitter;
  killed: boolean;
}

function makeChild(opts: { exitImmediately?: number; signal?: NodeJS.Signals | null } = {}): FakeChild {
  const child: FakeChild = {
    pid: 12345,
    exitCode: opts.exitImmediately ?? null,
    signalCode: opts.signal ?? null,
    stderr: new EventEmitter(),
    killed: false,
  };
  // daemon calls child.kill(); model it as setting exitCode + a killed flag.
  (child as unknown as { kill: () => void }).kill = () => {
    child.killed = true;
    child.exitCode = child.exitCode ?? 0;
  };
  return child;
}

/** fetch that reports /health as healthy only when `alive` is true. */
function healthFetch(alive: { value: boolean }): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (String(url).includes("/health")) {
      if (!alive.value) throw new Error("ECONNREFUSED");
      return new Response("ok", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

interface SpawnResult {
  child: FakeChild;
  calls: { binary: string; args: string[] }[];
}

function makeDaemon(opts: {
  alive: { value: boolean };
  spawnResult: SpawnResult;
  exitImmediately?: number;
  nowStep?: number; // if set, now() grows fast to force a timeout
  exists?: (p: string) => boolean;
}) {
  const { alive, spawnResult } = opts;
  const spawnImpl = ((binary: string, args: string[]) => {
    const child = makeChild({ exitImmediately: opts.exitImmediately });
    alive.value = true; // daemon becomes responsive once spawned
    (spawnResult as SpawnResult).child = child;
    (spawnResult as SpawnResult).calls.push({ binary, args });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  let n = 0;
  return new KonnectDaemon(
    {
      env: { KONNECT_BINARY: "/bin/konnect", KICAD_CLI: "/bin/kicad-cli" },
      home: "/h",
      platform: "darwin",
      cwd: "/proj",
      exists: opts.exists ?? (() => true),
    },
    {
      fetchImpl: healthFetch(alive),
      spawnImpl,
      writeFile: async () => {},
      tmpdir: () => "/tmp",
      now: () => (opts.nowStep ? (n += opts.nowStep) : 0),
      sleep: async () => {},
    },
  );
}

// ---------------------------------------------------------------------------

describe("daemon", () => {
  describe("buildSpawnArgs", () => {
    it("passes --config <path>", () => {
      assert.deepEqual(buildSpawnArgs("/bin/konnect", "/tmp/k.toml"), ["--config", "/tmp/k.toml"]);
    });
  });

  describe("pickFreePort", () => {
    it("returns a usable port number", async () => {
      const p = await pickFreePort(0); // 0 = OS-assigned, always free
      assert.isAbove(p, 0);
    });
  });

  describe("KonnectDaemon.ensure", () => {
    it("reuses a healthy daemon already on the preferred port (no spawn)", async () => {
      const alive = { value: true }; // daemon already up before we start
      const spawnResult: SpawnResult = { child: makeChild(), calls: [] };
      const d = makeDaemon({ alive, spawnResult });
      const port = await d.ensure();
      assert.equal(port, 31337, "preferred port reused");
      assert.equal(spawnResult.calls.length, 0, "did not spawn");
      const status = await d.getStatus();
      assert.isTrue(status.reused);
      assert.isTrue(status.healthy);
    });

    it("spawns when the preferred port is empty and becomes healthy", async () => {
      const alive = { value: false }; // nothing up initially
      const spawnResult: SpawnResult = { child: makeChild(), calls: [] };
      const d = makeDaemon({ alive, spawnResult });
      const port = await d.ensure();
      assert.equal(spawnResult.calls.length, 1, "spawned exactly once");
      assert.equal(spawnResult.calls[0].binary, "/bin/konnect");
      assert.match(spawnResult.calls[0].args.join(" "), /--config/);
      assert.isAbove(port, 0, "got a free port (may differ from 31337 if occupied)");
      const status = await d.getStatus();
      assert.isFalse(status.reused);
      assert.isTrue(status.healthy);
    });

    it("throws if the child exits before becoming healthy", async () => {
      const alive = { value: false };
      const spawnResult: SpawnResult = { child: makeChild(), calls: [] };
      const d = makeDaemon({ alive, spawnResult, exitImmediately: 1 });
      try {
        await d.ensure();
        assert.fail("expected rejection");
      } catch (e) {
        assert.match((e as Error).message, /exited \(code 1\) before becoming healthy/);
      }
    });

    it("throws and kills the child on startup timeout", async () => {
      const alive = { value: false }; // never becomes healthy
      const spawnResult: SpawnResult = { child: makeChild(), calls: [] };
      const d = makeDaemon({ alive, spawnResult, nowStep: STARTUP_TIMEOUT_MS + 1 });
      try {
        await d.ensure();
        assert.fail("expected rejection");
      } catch (e) {
        assert.match((e as Error).message, new RegExp(`did not become healthy within ${STARTUP_TIMEOUT_MS}ms`));
      }
      assert.isTrue(spawnResult.child.killed, "child killed on timeout");
    });

    it("throws a clear error when the binary is not found", async () => {
      const alive = { value: false };
      const spawnResult: SpawnResult = { child: makeChild(), calls: [] };
      const d = makeDaemon({ alive, spawnResult, exists: () => false });
      try {
        await d.ensure();
        assert.fail("expected rejection");
      } catch (e) {
        assert.match((e as Error).message, /Konnect binary not found/);
      }
      assert.equal(spawnResult.calls.length, 0);
    });

    it("is idempotent: second ensure reuses the running child", async () => {
      const alive = { value: false };
      const spawnResult: SpawnResult = { child: makeChild(), calls: [] };
      const d = makeDaemon({ alive, spawnResult });
      const p1 = await d.ensure();
      const p2 = await d.ensure();
      assert.equal(p1, p2);
      assert.equal(spawnResult.calls.length, 1, "spawned only once across two ensures");
    });
  });

  describe("KonnectDaemon.stop", () => {
    it("kills the owned child", async () => {
      const alive = { value: false };
      const spawnResult: SpawnResult = { child: makeChild(), calls: [] };
      const d = makeDaemon({ alive, spawnResult });
      await d.ensure();
      d.stop();
      assert.isTrue(spawnResult.child.killed);
    });
  });
});
