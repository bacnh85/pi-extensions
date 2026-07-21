import { describe, it } from "mocha";
import { expect } from "chai";
import { buildShellArgs, executeCommand, mergeEnv } from "../lib/shell-exec";

describe("shell-exec", () => {

  describe("buildShellArgs", () => {
    it("pwsh: builds correct args", () => {
      const { exe, args } = buildShellArgs("pwsh", "echo hello");
      expect(exe).to.match(/pwsh(\.exe)?$/i);
      expect(args).to.include("-NoLogo");
      expect(args).to.include("-NoProfile");
      expect(args).to.include("-NonInteractive");
      expect(args).to.include("-ExecutionPolicy");
      expect(args).to.include("Bypass");
      expect(args).to.include("-Command");
      expect(args).to.include("echo hello");
    });

    it("powershell: same args as pwsh", () => {
      const { exe, args } = buildShellArgs("powershell", "Get-ChildItem");
      expect(exe).to.match(/powershell(\.exe)?$/i);
      expect(args).to.include("-NoLogo");
      expect(args).to.include("-Command");
      expect(args).to.include("Get-ChildItem");
    });

    it("cmd: builds /c command", () => {
      const { exe, args } = buildShellArgs("cmd", "dir");
      expect(args).to.deep.equal(["/c", "dir"]);
    });

    it("git-bash: builds -lc command", () => {
      const { exe, args } = buildShellArgs("git-bash", "ls -la");
      expect(args).to.deep.equal(["-lc", "ls -la"]);
    });

    it("wsl: builds wsl.exe bash -lc command", () => {
      const { exe, args } = buildShellArgs("wsl", "uname -a");
      expect(exe).to.match(/wsl\.exe$/i);
      expect(args).to.deep.equal(["--", "bash", "-lc", "uname -a"]);
    });

    it("wsl with distro: includes -d flag", () => {
      const { args } = buildShellArgs("wsl", "echo hi", "Ubuntu-24.04");
      expect(args).to.deep.equal(["-d", "Ubuntu-24.04", "--", "bash", "-lc", "echo hi"]);
    });
  });

  it("does not spawn when the AbortSignal is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeCommand("this-command-must-not-run", { shell: "cmd", signal: controller.signal });
    expect(result.cancelled).to.be.true;
    expect(result.exitCode).to.equal(null);
  });

  describe("mergeEnv", () => {
    it("includes all process.env keys", () => {
      const merged = mergeEnv({});
      expect(merged.PATH || merged.Path).to.be.a("string");
    });

    it("custom env overrides process.env", () => {
      const merged = mergeEnv({ NODE_ENV: "test" });
      expect(merged.NODE_ENV).to.equal("test");
    });

    it("deduplicates case-insensitively", () => {
      // Simulate process.env having "PATH" and custom having "Path"
      // mergeEnv should not produce both
      const merged = mergeEnv({ Path: "/custom/path" });
      // Should have either PATH or Path, not both duplicated
      const pathKeys = Object.keys(merged).filter(k => k.toLowerCase() === "path");
      expect(pathKeys.length).to.equal(1);
      expect(merged[pathKeys[0]]).to.equal("/custom/path");
    });

    it("handles empty custom env", () => {
      const merged = mergeEnv({});
      expect(Object.keys(merged).length).to.be.greaterThan(0);
    });
  });
});
