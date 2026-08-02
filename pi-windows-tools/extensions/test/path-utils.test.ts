import { describe, it } from "mocha";
import { expect } from "chai";
import {
  toPosixPath,
  toWindowsPath,
  toWslPath,
  normalizeWindowsPath,
  isWindowsAbsolutePath,
  quoteForShell,
  parseWslUncPath,
} from "../lib/path-utils";
import type { WindowsShellKind } from "../lib/shell-detect";

describe("path-utils", () => {

  describe("toPosixPath", () => {
    it("converts C:\\foo\\bar to /c/foo/bar", () => {
      expect(toPosixPath("C:\\foo\\bar")).to.equal("/c/foo/bar");
    });
    it("converts C:/foo/bar to /c/foo/bar", () => {
      expect(toPosixPath("C:/foo/bar")).to.equal("/c/foo/bar");
    });
    it("converts D:\\path with spaces to /d/path with spaces", () => {
      expect(toPosixPath("D:\\path with spaces")).to.equal("/d/path with spaces");
    });
    it("handles lowercase drive letter", () => {
      expect(toPosixPath("c:\\windows\\system32")).to.equal("/c/windows/system32");
    });
    it("strips \\\\?\\ long-path prefix", () => {
      expect(toPosixPath("\\\\?\\C:\\foo")).to.equal("/c/foo");
    });
    it("preserves drive-relative path C:foo\\bar", () => {
      expect(toPosixPath("C:foo\\bar")).to.equal("C:foo/bar");
    });
  });

  describe("toWindowsPath", () => {
    it("converts /c/foo/bar to C:\\foo\\bar", () => {
      expect(toWindowsPath("/c/foo/bar")).to.equal("C:\\foo\\bar");
    });
    it("converts /mnt/c/foo/bar to C:\\foo\\bar", () => {
      expect(toWindowsPath("/mnt/c/foo/bar")).to.equal("C:\\foo\\bar");
    });
    it("preserves unrelated relative paths", () => {
      expect(toWindowsPath("relative/path")).to.equal("relative/path");
    });
    it("handles lowercase drive", () => {
      expect(toWindowsPath("/d/work/repo")).to.equal("D:\\work\\repo");
    });
    it("preserves Windows-native paths already in C:\\ format", () => {
      expect(toWindowsPath("C:\\Users\\me")).to.equal("C:\\Users\\me");
    });
    it("supports drive roots and preserves unrelated POSIX paths", () => {
      expect(toWindowsPath("/c/")).to.equal("C:\\");
      expect(toWindowsPath("/mnt/c/")).to.equal("C:\\");
      expect(toWindowsPath("/home/me")).to.equal("/home/me");
    });
  });

  describe("toWslPath", () => {
    it("converts C:\\Users\\me to /mnt/c/Users/me", () => {
      expect(toWslPath("C:\\Users\\me")).to.equal("/mnt/c/Users/me");
    });
    it("converts D:\\work to /mnt/d/work", () => {
      expect(toWslPath("D:\\work")).to.equal("/mnt/d/work");
    });
    it("does not double-wrap already-WSL paths", () => {
      expect(toWslPath("/mnt/c/Users/me")).to.equal("/mnt/c/Users/me");
    });
    it("wraps Git Bash paths to /mnt/", () => {
      expect(toWslPath("/c/foo")).to.equal("/mnt/c/foo");
    });
    it("preserves unrelated POSIX and relative paths", () => {
      expect(toWslPath("/home/me")).to.equal("/home/me");
      expect(toWslPath("relative/path")).to.equal("relative/path");
    });
  });

  describe("parseWslUncPath", () => {
    it("parses \\wsl.localhost\\<distro>\\<path>", () => {
      expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\foo")).to.deep.equal({ distro: "Ubuntu", posixPath: "/home/foo" });
    });
    it("parses \\wsl$\\<distro>\\<path>", () => {
      expect(parseWslUncPath("\\\\wsl$\\Debian\\tmp")).to.deep.equal({ distro: "Debian", posixPath: "/tmp" });
    });
    it("handles distro-only UNC (root path)", () => {
      expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu")).to.deep.equal({ distro: "Ubuntu", posixPath: "/" });
    });
    it("parses distro with version suffix", () => {
      expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\kim\\proj")).to.deep.equal({ distro: "Ubuntu-22.04", posixPath: "/home/kim/proj" });
    });
    it("returns null for regular Windows drive path", () => {
      expect(parseWslUncPath("C:\\foo\\bar")).to.equal(null);
    });
    it("returns null for regular UNC share", () => {
      expect(parseWslUncPath("\\\\server\\share\\foo")).to.equal(null);
    });
    it("preserves trailing slash", () => {
      expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\foo\\")).to.deep.equal({ distro: "Ubuntu", posixPath: "/home/foo/" });
    });
    it("accepts forward-slash UNC input", () => {
      expect(parseWslUncPath("//wsl.localhost/Ubuntu/home/foo")).to.deep.equal({ distro: "Ubuntu", posixPath: "/home/foo" });
    });
    it("handles paths with spaces", () => {
      expect(parseWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\My Project")).to.deep.equal({ distro: "Ubuntu", posixPath: "/home/My Project" });
    });
    it("handles mixed-case host", () => {
      expect(parseWslUncPath("\\\\Wsl.LocalHost\\Ubuntu\\home\\foo")).to.deep.equal({ distro: "Ubuntu", posixPath: "/home/foo" });
    });
    it("returns null for empty input", () => {
      expect(parseWslUncPath("")).to.equal(null);
    });
  });

  describe("toWslPath UNC", () => {
    it("strips distro from \\wsl.localhost UNC", () => {
      expect(toWslPath("\\\\wsl.localhost\\Ubuntu\\home\\foo")).to.equal("/home/foo");
    });
    it("strips distro from \\wsl$ UNC", () => {
      expect(toWslPath("\\\\wsl$\\Debian\\tmp")).to.equal("/tmp");
    });
  });

  describe("normalizeWindowsPath", () => {
    it("converts forward slashes to backslashes", () => {
      expect(normalizeWindowsPath("C:/foo/bar")).to.equal("C:\\foo\\bar");
    });
    it("uppercases drive letter", () => {
      expect(normalizeWindowsPath("c:\\windows")).to.equal("C:\\windows");
    });
    it("resolves . and ..", () => {
      expect(normalizeWindowsPath("C:\\foo\\.\\bar\\..\\baz")).to.equal("C:\\foo\\baz");
    });
    it("deduplicates backslashes", () => {
      expect(normalizeWindowsPath("C:\\foo\\\\\\bar")).to.equal("C:\\foo\\bar");
    });
  });

  describe("isWindowsAbsolutePath", () => {
    it("detects C:\\ as absolute", () => {
      expect(isWindowsAbsolutePath("C:\\foo")).to.be.true;
    });
    it("detects C:/ as absolute", () => {
      expect(isWindowsAbsolutePath("C:/foo")).to.be.true;
    });
    it("detects UNC as absolute", () => {
      expect(isWindowsAbsolutePath("\\\\server\\share")).to.be.true;
    });
    it("detects \\\\?\\ long path prefix as absolute", () => {
      expect(isWindowsAbsolutePath("\\\\?\\C:\\foo")).to.be.true;
    });
    it("detects \\\\.\\ device paths as absolute", () => {
      expect(isWindowsAbsolutePath("\\\\.\\COM1")).to.be.true;
    });
    it("rejects relative paths", () => {
      expect(isWindowsAbsolutePath("relative\\path")).to.be.false;
    });
    it("rejects POSIX absolute paths", () => {
      expect(isWindowsAbsolutePath("/c/foo")).to.be.false;
    });
  });

  describe("quoteForShell", () => {
    const shells: WindowsShellKind[] = ["pwsh", "powershell", "cmd", "git-bash", "wsl"];

    it("always quotes paths", () => {
      for (const s of shells) expect(quoteForShell("C:\\foo\\bar", s)).to.match(/^["']/);
    });
    it("quotes paths with spaces for PowerShell", () => {
      expect(quoteForShell("C:\\Program Files\\Git", "pwsh")).to.include("'");
    });
    it("quotes paths with spaces for cmd", () => {
      expect(quoteForShell("C:\\Program Files\\Git", "cmd")).to.include('"');
    });
    it("quotes paths with spaces for git-bash", () => {
      expect(quoteForShell("/c/Program Files", "git-bash")).to.include("'");
    });
    it("quotes paths with spaces for wsl", () => {
      expect(quoteForShell("/mnt/c/Program Files", "wsl")).to.include("'");
    });
    it("handles empty path", () => {
      for (const s of shells) expect(quoteForShell("", s)).to.match(/^["']/);
    });
    it("quotes shell metacharacters and rejects cmd variable expansion", () => {
      for (const s of shells.filter(s => s !== "cmd")) expect(quoteForShell("x&$();|`", s)).to.match(/^'/);
      expect(() => quoteForShell("x%USERPROFILE%", "cmd")).to.throw();
    });
  });
});
