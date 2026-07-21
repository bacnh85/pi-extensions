import { describe, it } from "mocha";
import { expect } from "chai";
import { detectAllShells, detectShell, getAvailableShells, getDefaultShell } from "../lib/shell-detect";
import type { WindowsShellKind } from "../lib/shell-detect";

describe("shell-detect", () => {
  it("detectAllShells returns 5 entries", () => {
    const shells = detectAllShells();
    expect(shells).to.have.length(5);
    const kinds = shells.map(s => s.kind);
    expect(kinds).to.include.members(["pwsh", "powershell", "cmd", "git-bash", "wsl"]);
  });

  it("each shell has kind, displayName, executable, available", () => {
    for (const s of detectAllShells()) {
      expect(s.kind).to.be.a("string");
      expect(s.displayName).to.be.a("string");
      expect(s.executable).to.be.a("string");
      expect(s.available).to.be.a("boolean");
    }
  });

  it("cmd is available on Windows", function () {
    if (process.platform !== "win32") this.skip();
    const cmd = detectShell("cmd");
    expect(cmd.available).to.be.true;
    expect(cmd.executable).to.match(/cmd(\.exe)?$/i);
  });

  it("detectShell returns info for each kind", () => {
    const kinds: WindowsShellKind[] = ["pwsh", "powershell", "cmd", "git-bash", "wsl"];
    for (const k of kinds) {
      const info = detectShell(k);
      expect(info.kind).to.equal(k);
      expect(info.executable).to.be.a("string").and.not.empty;
    }
  });

  it("getAvailableShells returns only available shells", function () {
    if (process.platform !== "win32") this.skip();
    const avail = getAvailableShells();
    for (const s of avail) {
      expect(s.available).to.be.true;
    }
  });

  it("getDefaultShell returns a shell", function () {
    if (process.platform !== "win32") this.skip();
    const def = getDefaultShell();
    expect(def.kind).to.be.a("string");
    expect(def.available).to.be.true;
  });
});
