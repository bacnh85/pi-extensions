import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { buildShellArgs, executeCommand, mergeEnv, shouldEncode, encodeForPwsh, resolveWslDistro } from "../lib/shell-exec";

describe("shell-exec", function () {
  // buildShellArgs probes real binaries (where.exe + --version, 3s timeouts each)
  // — flaky under mocha's 2s default on loaded runners (failed main run 32209298980).
  this.timeout(15000);

  describe("buildShellArgs", () => {
    it("pwsh: builds correct args", () => {
      const { exe, args } = buildShellArgs("pwsh", "echo hello");
      expect(exe).to.match(/pwsh(\.exe)?$/i);
      expect(args).to.include("-NoLogo");
      expect(args).to.include("-NoProfile");
      expect(args).to.include("-NonInteractive");
      expect(args).to.not.include("-ExecutionPolicy"); // issue #20 L4: not needed for -Command
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

    it("pwsh: uses -EncodedCommand for multi-line input", () => {
      const { args } = buildShellArgs("pwsh", "Get-ChildItem\nSet-Location ..");
      expect(args).to.include("-EncodedCommand");
      expect(args).to.not.include("-Command");
    });

    it("pwsh: uses -Command for simple input", () => {
      const { args } = buildShellArgs("pwsh", "Get-ChildItem");
      expect(args).to.include("-Command");
      expect(args).to.not.include("-EncodedCommand");
    });
  });

  describe("shouldEncode", () => {
    it("returns false for simple one-line command", () => {
      expect(shouldEncode("echo hello")).to.be.false;
    });
    it("returns true for multi-line command", () => {
      expect(shouldEncode("line1\nline2")).to.be.true;
    });
    it("returns true for \r-only command", () => {
      expect(shouldEncode("line1\rline2")).to.be.true;
    });
    it("returns true for long command (>2000 chars)", () => {
      expect(shouldEncode("a".repeat(2001))).to.be.true;
    });
    it("returns false at the 2000-char boundary", () => {
      expect(shouldEncode("a".repeat(2000))).to.be.false;
    });
  });

  describe("encodeForPwsh", () => {
    it("round-trips via UTF-16LE base64 decode", () => {
      const cmd = "Get-ChildItem -Path 'C:\\foo bar'";
      const encoded = encodeForPwsh(cmd);
      expect(Buffer.from(encoded, "base64").toString("utf16le")).to.equal(cmd);
    });
    it("round-trips unicode (CJK + emoji)", () => {
      const cmd = "Write-Host 'こんにちは🌍'";
      expect(Buffer.from(encodeForPwsh(cmd), "base64").toString("utf16le")).to.equal(cmd);
    });
  });

  describe("resolveWslDistro", () => {
    let savedDistro: string | undefined;
    beforeEach(() => { savedDistro = process.env.PI_WSL_DISTRO; delete process.env.PI_WSL_DISTRO; });
    afterEach(() => { if (savedDistro !== undefined) process.env.PI_WSL_DISTRO = savedDistro; });
    it("extracts distro from wsl.localhost UNC cwd", () => {
      expect(resolveWslDistro("wsl", "\\\\wsl.localhost\\Ubuntu\\home\\proj")).to.equal("Ubuntu");
    });
    it("extracts distro from wsl$ UNC cwd", () => {
      expect(resolveWslDistro("wsl", "\\\\wsl$\\Debian\\tmp")).to.equal("Debian");
    });
    it("returns undefined for non-WSL cwd", () => {
      expect(resolveWslDistro("wsl", "C:\\Users\\me")).to.be.undefined;
    });
    it("returns undefined for non-wsl shell even with UNC cwd", () => {
      expect(resolveWslDistro("cmd", "\\\\wsl.localhost\\Ubuntu\\home\\proj")).to.be.undefined;
    });
    it("returns undefined when cwd is undefined", () => {
      expect(resolveWslDistro("wsl", undefined)).to.be.undefined;
    });
  });

  describe("shouldEncode negative cases (non-PowerShell shells)", () => {
    it("cmd ignores the encode heuristic even for long commands", () => {
      const { args } = buildShellArgs("cmd", "a".repeat(3000));
      expect(args).to.not.include("-EncodedCommand");
    });
    it("git-bash ignores the encode heuristic", () => {
      const { args } = buildShellArgs("git-bash", "a\nb");
      expect(args).to.not.include("-EncodedCommand");
    });
    it("wsl ignores the encode heuristic", () => {
      const { args } = buildShellArgs("wsl", "a\nb");
      expect(args).to.not.include("-EncodedCommand");
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

// ponytail: spawn node (cross-platform, always present) to exercise onChunk end-to-end
describe("onChunk streaming", () => {
  const nodeOut = "node -e process.stdout.write(JSON.stringify('hello'))";
  const nodeErr = "node -e process.stderr.write(JSON.stringify('boom'))";

  it("invokes onChunk for stdout with stream label", async () => {
    const chunks: { text: string; stream: string }[] = [];
    const r = await executeCommand(nodeOut, { shell: "cmd", onChunk: (text, stream) => chunks.push({ text, stream }) });
    expect(r.stdout).to.include("hello");
    expect(chunks.some(c => c.text.includes("hello") && c.stream === "stdout")).to.be.true;
  });

  it("invokes onChunk for stderr with stream label", async () => {
    const chunks: { text: string; stream: string }[] = [];
    const r = await executeCommand(nodeErr, { shell: "cmd", onChunk: (text, stream) => chunks.push({ text, stream }) });
    expect(r.stderr).to.include("boom");
    expect(chunks.some(c => c.text.includes("boom") && c.stream === "stderr")).to.be.true;
  });

  it("does not invoke onChunk when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await executeCommand(nodeOut, { shell: "cmd", signal: controller.signal, onChunk: () => { called = true; } });
    expect(called).to.be.false;
  });
});
