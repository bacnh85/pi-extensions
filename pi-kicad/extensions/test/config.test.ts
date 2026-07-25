import { assert } from "chai";
import {
  tomlString,
  generateKonnectToml,
  buildDaemonConfig,
  type DaemonConfig,
} from "../lib/config.js";
import type { ResolvedConfig } from "../lib/discovery.js";

describe("config (TOML generation)", () => {
  describe("tomlString", () => {
    it("quotes and escapes backslash + double-quote", () => {
      assert.equal(tomlString("plain"), '"plain"');
      assert.equal(tomlString('a"b'), '"a\\"b"');
      assert.equal(tomlString("C:\\bin"), '"C:\\\\bin"');
    });
  });

  describe("generateKonnectToml", () => {
    it("emits transport + http_address always, others when present", () => {
      const full: DaemonConfig = {
        transport: "http",
        httpAddress: "127.0.0.1:31337",
        kicadCli: "/usr/bin/kicad-cli",
        ipcAddress: "ipc:///tmp/kicad/api.sock",
        projectDir: "/home/me/project",
        logLevel: "info",
      };
      const toml = generateKonnectToml(full);
      assert.match(toml, /transport = "http"/);
      assert.match(toml, /http_address = "127\.0\.0\.1:31337"/);
      assert.include(toml, 'kicad_cli = "/usr/bin/kicad-cli"');
      assert.include(toml, 'ipc_address = "ipc:///tmp/kicad/api.sock"');
      assert.include(toml, 'project_dir = "/home/me/project"');
      assert.match(toml, /log_level = "info"/);
      assert.match(toml, /\n$/, "trailing newline");
    });

    it("omits null/undefined optional fields", () => {
      const toml = generateKonnectToml({ transport: "http", httpAddress: "127.0.0.1:9" });
      assert.notMatch(toml, /kicad_cli/);
      assert.notMatch(toml, /ipc_address/);
      assert.notMatch(toml, /project_dir/);
      assert.notMatch(toml, /log_level/);
    });

    it("escapes windows paths in kicad_cli", () => {
      const toml = generateKonnectToml({
        transport: "http",
        httpAddress: "127.0.0.1:31337",
        kicadCli: "C:\\Program Files\\KiCad\\bin\\kicad-cli.exe",
      });
      assert.match(toml, /kicad_cli = "C:\\\\Program Files\\\\KiCad\\\\bin\\\\kicad-cli\.exe"/);
    });
  });

  describe("buildDaemonConfig", () => {
    it("maps ResolvedConfig + port to a DaemonConfig", () => {
      const cfg: ResolvedConfig = {
        konnectBinary: "/bin/konnect",
        kicadCli: "/usr/bin/kicad-cli",
        ipcSocket: "ipc:///tmp/x.sock",
        httpPort: 31337,
        logLevel: "debug",
        cwd: "/tmp",
        sharedSupport: "/opt/kicad/SharedSupport",
        userDir: "/home/me/.local/share/kicad",
        projectDir: "/proj",
        symbolDir: "/proj",
      };
      const dc = buildDaemonConfig(cfg, 4000);
      assert.equal(dc.transport, "http");
      assert.equal(dc.httpAddress, "127.0.0.1:4000");
      assert.equal(dc.kicadCli, "/usr/bin/kicad-cli");
      assert.equal(dc.ipcAddress, "ipc:///tmp/x.sock");
      assert.equal(dc.projectDir, "/proj");
      assert.equal(dc.logLevel, "debug");
    });

    it("carries null through for missing discovery results", () => {
      const cfg: ResolvedConfig = {
        konnectBinary: null,
        kicadCli: null,
        ipcSocket: null,
        httpPort: 31337,
        logLevel: "info",
        cwd: "/tmp",
        sharedSupport: null,
        userDir: null,
        projectDir: null,
        symbolDir: null,
      };
      const dc = buildDaemonConfig(cfg, 1);
      assert.isNull(dc.kicadCli);
      assert.isNull(dc.ipcAddress);
    });
  });
});
