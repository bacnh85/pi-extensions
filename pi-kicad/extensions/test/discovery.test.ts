import { assert } from "chai";
import {
  konnectBinaryCandidates,
  kicadCliCandidates,
  resolveIpcSocket,
  resolveFirstExisting,
  resolveConfig,
  buildKiCadEnv,
  kiCadSharedSupportCandidates,
  DEFAULT_HTTP_PORT,
  type OsPlatform,
  type ResolvedConfig,
} from "../lib/discovery.js";

const ENV = {};

describe("discovery", () => {
  describe("konnectBinaryCandidates", () => {
    it("env override comes first", () => {
      const c = konnectBinaryCandidates({ KONNECT_BINARY: "/custom/konnect" }, "/h", "darwin");
      assert.equal(c[0], "/custom/konnect");
    });

    it("darwin includes the KiCad 10 PCM plugin path", () => {
      const c = konnectBinaryCandidates(ENV, "/Users/me", "darwin" as OsPlatform);
      assert.includeMembers(c, [
        "/Users/me/Documents/KiCad/10.0/3rdparty/plugins/com_github_mixelpixx_konnect/bin/konnect",
      ]);
    });

    it("linux includes the share kicad plugin path", () => {
      const c = konnectBinaryCandidates(ENV, "/home/me", "linux" as OsPlatform);
      assert.isTrue(c.some((p) => p.includes(".local/share/kicad/10.0/3rdparty")));
    });

    it("win32 uses .exe and USERPROFILE", () => {
      const c = konnectBinaryCandidates({ USERPROFILE: "C:\\Users\\me" }, "C:\\Users\\me", "win32" as OsPlatform);
      assert.isTrue(c.some((p) => p.endsWith("konnect.exe")));
      assert.isTrue(c.some((p) => p.includes("Documents\\KiCad\\10.0\\3rdparty")));
    });
  });

  describe("kicadCliCandidates", () => {
    it("env override first", () => {
      const c = kicadCliCandidates({ KICAD_CLI: "/x/kicad-cli" }, "/h", "darwin");
      assert.equal(c[0], "/x/kicad-cli");
    });

    it("darwin points at the app bundle", () => {
      const c = kicadCliCandidates(ENV, "/h", "darwin" as OsPlatform);
      assert.include(c, "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli");
    });
  });

  describe("resolveIpcSocket", () => {
    it("returns the env value when set", () => {
      assert.equal(resolveIpcSocket({ KICAD_API_SOCKET: "ipc:///tmp/k.sock" }), "ipc:///tmp/k.sock");
    });
    it("returns null when unset (let Konnect auto-detect)", () => {
      assert.isNull(resolveIpcSocket({}));
    });
  });

  describe("resolveFirstExisting", () => {
    it("returns the first existing candidate", () => {
      const exists = (p: string) => p === "/b";
      assert.equal(resolveFirstExisting(["/a", "/b", "/c"], exists), "/b");
    });
    it("returns null when none exist", () => {
      assert.isNull(resolveFirstExisting(["/a", "/b"], () => false));
    });
  });

  describe("resolveConfig", () => {
    it("uses injected exists to pick candidates and reads port/loglevel from env", () => {
      const cfg = resolveConfig({
        env: {
          KONNECT_BINARY: "/bin/konnect",
          KICAD_CLI: "/bin/kicad-cli",
          KICAD_API_SOCKET: "ipc:///tmp/k.sock",
          KICAD_HTTP_PORT: "4242",
          KICAD_LOG_LEVEL: "debug",
        },
        home: "/h",
        platform: "darwin",
        cwd: "/proj",
        exists: () => true,
      });
      assert.equal(cfg.konnectBinary, "/bin/konnect");
      assert.equal(cfg.kicadCli, "/bin/kicad-cli");
      assert.equal(cfg.ipcSocket, "ipc:///tmp/k.sock");
      assert.equal(cfg.httpPort, 4242);
      assert.equal(cfg.logLevel, "debug");
      assert.equal(cfg.cwd, "/proj");
    });

    it("falls back to default port on bad/missing env", () => {
      const cfg = resolveConfig({ env: {}, exists: () => false });
      assert.equal(cfg.httpPort, DEFAULT_HTTP_PORT);
      assert.isNull(cfg.konnectBinary);
      assert.isNull(cfg.kicadCli);
    });
  });

  describe("kiCadSharedSupportCandidates", () => {
    it("darwin returns the app-bundle SharedSupport path", () => {
      const c = kiCadSharedSupportCandidates({}, "/h", "darwin" as OsPlatform);
      assert.include(c[0], "KiCad.app/Contents/SharedSupport");
    });
    it("respects KICAD_SHARED_SUPPORT override", () => {
      const c = kiCadSharedSupportCandidates({ KICAD_SHARED_SUPPORT: "/opt/ss" }, "/h", "linux" as OsPlatform);
      assert.deepEqual(c, ["/opt/ss"]);
    });
  });

  describe("buildKiCadEnv", () => {
    const base: ResolvedConfig = {
      konnectBinary: null,
      kicadCli: null,
      ipcSocket: null,
      httpPort: 31337,
      logLevel: "info",
      cwd: "/tmp",
      sharedSupport: "/ss",
      userDir: "/home/me/kicad",
      projectDir: "/proj",
      symbolDir: "/proj",
    };

    it("sets KICAD10_SYMBOL_DIR from symbolDir (project wins) + others from sharedSupport", () => {
      const env = buildKiCadEnv(base, (p) => p === "/ss/footprints");
      assert.equal(env.KICAD10_SYMBOL_DIR, "/proj", "symbolDir wins over shared symbols");
      assert.equal(env.KICAD10_FOOTPRINT_DIR, "/ss/footprints");
      assert.isUndefined(env.KICAD10_TEMPLATE_DIR);
      assert.isUndefined(env.KICAD10_3DMODEL_DIR);
      assert.equal(env.KICAD_USER_DIR, "/home/me/kicad");
    });

    it("falls back to sharedSupport/symbols when no project/symbolDir", () => {
      const cfg = { ...base, projectDir: null, symbolDir: "/ss/symbols" };
      const env = buildKiCadEnv(cfg, () => true);
      assert.equal(env.KICAD10_SYMBOL_DIR, "/ss/symbols");
    });

    it("emits nothing when symbolDir/sharedSupport/userDir are null", () => {
      const env = buildKiCadEnv({ ...base, sharedSupport: null, userDir: null, symbolDir: null, projectDir: null }, () => true);
      assert.deepEqual(env, {});
    });
  });
});
