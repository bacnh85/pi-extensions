import { describe, it } from "mocha";
import { expect } from "chai";
import {
	toPosixPath,
	toWindowsPath,
	toWslPath,
	toGitBashPath,
	normalizeWindowsPath,
	isWindowsAbsolutePath,
	quoteForShell,
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
		it("handles drive-relative path C:foo\\bar", () => {
			expect(toPosixPath("C:foo\\bar")).to.equal("/c/foo/bar");
		});
	});

	describe("toWindowsPath", () => {
		it("converts /c/foo/bar to C:\\foo\\bar", () => {
			expect(toWindowsPath("/c/foo/bar")).to.equal("C:\\foo\\bar");
		});
		it("converts /mnt/c/foo/bar to C:\\foo\\bar", () => {
			expect(toWindowsPath("/mnt/c/foo/bar")).to.equal("C:\\foo\\bar");
		});
		it("preserves relative paths", () => {
			expect(toWindowsPath("relative/path")).to.equal("relative\\path");
		});
		it("handles lowercase drive", () => {
			expect(toWindowsPath("/d/work/repo")).to.equal("D:\\work\\repo");
		});
		it("preserves Windows-native paths already in C:\\ format", () => {
			expect(toWindowsPath("C:\\Users\\me")).to.equal("C:\\Users\\me");
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
	});

	describe("toGitBashPath", () => {
		it("converts C:\\Users to /c/Users", () => {
			expect(toGitBashPath("C:\\Users")).to.equal("/c/Users");
		});
		it("same as toPosixPath", () => {
			expect(toGitBashPath("D:\\temp")).to.equal(toPosixPath("D:\\temp"));
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

		it("does not quote paths without spaces", () => {
			for (const s of shells) {
				expect(quoteForShell("C:\\foo\\bar", s)).to.equal("C:\\foo\\bar");
			}
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
			for (const s of shells) {
				expect(quoteForShell("", s)).to.equal('""');
			}
		});
	});
});
