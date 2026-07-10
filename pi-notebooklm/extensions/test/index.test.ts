import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import { existsSync, readFileSync } from "node:fs";

import {
	isDestructive,
	requiresYesFlag,
	isBlockedInteractive,
	truncateOutput,
	extractCommandPath,
	extractOutputPaths,
} from "../index.js";

// ---------------------------------------------------------------------------
// extractCommandPath
// ---------------------------------------------------------------------------

describe("extractCommandPath", () => {
	it("extracts a simple command", () => {
		const { path, rest } = extractCommandPath(["list", "--json"]);
		expect(path).to.deep.equal(["list"]);
		expect(rest).to.deep.equal(["--json"]);
	});

	it("extracts a group subcommand", () => {
		const { path, rest } = extractCommandPath(["source", "list", "-n", "<id>", "--json"]);
		expect(path).to.deep.equal(["source", "list"]);
		expect(rest).to.deep.equal(["-n", "<id>", "--json"]);
	});

	it("skips global options before the command", () => {
		const { path } = extractCommandPath(["--profile", "work", "login"]);
		expect(path).to.deep.equal(["login"]);
	});

	it("skips --storage and --profile", () => {
		const { path } = extractCommandPath(["--storage", "path.json", "-p", "work", "delete", "-n", "<id>", "-y"]);
		expect(path).to.deep.equal(["delete"]);
	});

	it("treats boolean flags as skippable", () => {
		const { path } = extractCommandPath(["-v", "list", "--json"]);
		expect(path).to.deep.equal(["list"]);
	});

	it("handles ask with question", () => {
		const { path, rest } = extractCommandPath(["ask", "how do I delete this", "-n", "<id>"]);
		expect(path).to.deep.equal(["ask"]);
		expect(rest).to.deep.equal(["how do I delete this", "-n", "<id>"]);
	});

	it("skips -- end-of-options marker and continues parsing", () => {
		const { path } = extractCommandPath(["--", "delete", "-n", "<id>", "-y"]);
		expect(path).to.deep.equal(["delete"]);
	});

	it("skips -- before group subcommand", () => {
		const { path } = extractCommandPath(["--", "source", "list", "--json"]);
		expect(path).to.deep.equal(["source", "list"]);
	});

	it("handles bare -- alone", () => {
		const { path } = extractCommandPath(["--"]);
		expect(path).to.deep.equal([]);
	});
});

// ---------------------------------------------------------------------------
// isDestructive
// ---------------------------------------------------------------------------

describe("isDestructive", () => {
	const destructive = [
		["delete", "-n", "<id>", "-y"],
		["-p", "work", "delete", "-n", "<id>", "-y"],
		["source", "delete", "-y", "<src-id>"],
		["note", "delete", "-y", "<note-id>"],
		["artifact", "delete", "-y", "<art-id>"],
		["profile", "delete", "-y", "<profile-id>"],
		["source", "clean", "-y"],
		["share", "remove", "-n", "<id>", "<email>"],
		["auth", "logout"],
		["ask", "--new", "question"],
		["ask", "question", "--new"],
		// -- end-of-options marker must not bypass gate
		["--", "delete", "-n", "<id>", "-y"],
		["--", "auth", "logout"],
		// --help after -- is positional, not a help flag
		["ask", "--new", "-y", "--", "--help"],
		["source", "delete-by-title", "-n", "<id>", "-y", "--", "--help"],
		// New destructive paths for v0.7.3
		["source", "delete-by-title", "-n", "<id>", "-y"],
		["skill", "uninstall", "-y"],
		["share", "public", "--enable", "-n", "<id>"],
		["share", "add", "<email>", "--permission", "viewer"],
		["share", "update", "<email>", "--permission", "editor"],
		["share", "view-level", "full"],
		["history", "--clear"],
		["--", "source", "delete-by-title", "-n", "<id>", "-y"],
		["--", "skill", "uninstall", "-y"],
		["clear"],
		// download with -a before output path
		["download", "audio", "-a", "<id>", "output.mp3", "--force"],
		// --help as option value (not a real help flag)
		["--storage", "--help", "delete", "-n", "<id>"],
	];

	const nonDestructive = [
		["list", "--json"],
		["create", "Research", "--json"],
		["auth", "check", "--test", "--json"],
		["doctor", "--json"],
		["source", "list", "-n", "<id>", "--json"],
		["source", "add", "https://example.com", "-n", "<id>", "--json"],
		["ask", "Summarize", "-n", "<id>", "--json"],
		// The word "delete" in a question must not trigger
		["ask", "how do I delete this", "-n", "<id>", "--json"],
		["ask", "Tell me about --delete option"],
		// source clean --dry-run is read-only preview, not destructive
		["source", "clean", "--dry-run"],
		["generate", "audio", "-n", "<id>"],
		["artifact", "poll", "<task>", "-n", "<id>", "--json"],
		["rename", "-n", "<id>", "New Title"],
		["summary", "-n", "<id>"],
		// --help is always read-only
		["source", "clean", "--help"],
		["source", "delete-by-title", "--help"],
		["profile", "delete", "--help"],
		["login", "--help"],
		// history alone is not destructive
		["history"],
		// --help before -- is genuinely read-only
		["--help"],
		["-h", "list"],
		// ask with --new after -- is a literal question, not conversation reset
		["ask", "--", "--new"],
	];

	for (const args of destructive) {
		it(`detects: notebooklm ${args.join(" ")}`, () => {
			expect(isDestructive(args)).to.be.true;
		});
	}

	for (const args of nonDestructive) {
		it(`allows: notebooklm ${args.join(" ")}`, () => {
			expect(isDestructive(args)).to.be.false;
		});
	}

	// Standalone assertions not covered by table
	it("detects source clean (without --dry-run) as destructive", () => {
		expect(isDestructive(["source", "clean"])).to.be.true;
	});

	it("detects -- bypassed source clean as destructive", () => {
		expect(isDestructive(["--", "source", "clean"])).to.be.true;
	});

	it("does not flag source clean --help as destructive", () => {
		expect(isDestructive(["source", "clean", "--help"])).to.be.false;
	});

	it("does not flag login --help as destructive", () => {
		expect(isDestructive(["login", "--help"])).to.be.false;
	});

	it("detects --storage --help delete as destructive (--help is storage value, not help flag)", () => {
		expect(isDestructive(["--storage", "--help", "delete", "-n", "<id>"])).to.be.true;
	});

	it("detects source delete-by-title as destructive", () => {
		expect(isDestructive(["source", "delete-by-title", "-n", "<id>"])).to.be.true;
	});

	it("allows history without --clear", () => {
		expect(isDestructive(["history"])).to.be.false;
	});

	it("detects skill uninstall as destructive", () => {
		expect(isDestructive(["skill", "uninstall"])).to.be.true;
	});

	it("detects share public --enable as destructive", () => {
		expect(isDestructive(["share", "public", "--enable"])).to.be.true;
	});

	it("detects share add as destructive", () => {
		expect(isDestructive(["share", "add", "user@x.com"])).to.be.true;
	});

	it("detects share update as destructive", () => {
		expect(isDestructive(["share", "update", "user@x.com"])).to.be.true;
	});

	it("detects share view-level as destructive", () => {
		expect(isDestructive(["share", "view-level", "full"])).to.be.true;
	});

	it("detects clear as destructive (removes shared profile context)", () => {
		expect(isDestructive(["clear"])).to.be.true;
	});

	describe("file overwrite (--force / -f)", () => {
		it("detects download --force as destructive", () => {
			expect(isDestructive(["download", "audio", "output.mp3", "-a", "<id>", "--force"])).to.be.true;
		});
		it("allows download with short -f (not --force in v0.7.3)", () => {
			expect(isDestructive(["download", "audio", "output.mp3", "-a", "<id>", "-f"])).to.be.false;
		});
		it("detects source fulltext --force as destructive", () => {
			expect(isDestructive(["source", "fulltext", "<src>", "-o", "output.md", "--force"])).to.be.true;
		});
		it("detects skill install --force as destructive", () => {
			expect(isDestructive(["skill", "install", "--scope", "project", "--force"])).to.be.true;
		});
		it("allows download without --force", () => {
			expect(isDestructive(["download", "audio", "output.mp3", "-a", "<id>"])).to.be.false;
		});
		it("allows source fulltext without --force", () => {
			expect(isDestructive(["source", "fulltext", "<src>"])).to.be.false;
		});
		it("allows download --force after -- (positional, not a flag)", () => {
			expect(isDestructive(["download", "audio", "output.mp3", "-a", "<id>", "--", "--force"])).to.be.false;
		});
	});
});

// ---------------------------------------------------------------------------
// requiresYesFlag
// ---------------------------------------------------------------------------

describe("requiresYesFlag", () => {
	it("requires --yes for delete commands", () => {
		expect(requiresYesFlag(["delete", "-n", "<id>"])).to.be.true;
		expect(requiresYesFlag(["source", "delete", "<src-id>"])).to.be.true;
	});

	it("accepts --yes flag", () => {
		expect(requiresYesFlag(["delete", "-n", "<id>", "--yes"])).to.be.false;
		expect(requiresYesFlag(["source", "delete", "-y", "<src-id>"])).to.be.false;
	});

	it("requires --yes for clean, remove", () => {
		expect(requiresYesFlag(["source", "clean"])).to.be.true;
		expect(requiresYesFlag(["share", "remove", "<email>"])).to.be.true;
	});

	it("does NOT require --yes for auth logout (v0.7.3 does not support it)", () => {
		expect(requiresYesFlag(["auth", "logout"])).to.be.false;
	});

	it("requires --yes for ask --new", () => {
		expect(requiresYesFlag(["ask", "--new", "question"])).to.be.true;
	});

	it("accepts --yes for ask --new", () => {
		expect(requiresYesFlag(["ask", "--new", "-y", "question"])).to.be.false;
		expect(requiresYesFlag(["ask", "--new", "question", "--yes"])).to.be.false;
	});

	it("does not flag ask without --new", () => {
		expect(requiresYesFlag(["ask", "Summarize", "-n", "<id>"])).to.be.false;
	});

	it("requires --yes when --yes is value of -s (not confirmation flag)", () => {
		expect(requiresYesFlag(["ask", "--new", "-s", "--yes", "question"])).to.be.true;
	});

	it("does not flag non-destructive commands", () => {
		expect(requiresYesFlag(["list", "--json"])).to.be.false;
		expect(requiresYesFlag(["source", "list", "-n", "<id>", "--json"])).to.be.false;
	});

	it("requires --yes when -y is value of --storage, not a confirmation flag", () => {
		// -y is the value for --storage, so it should NOT count as confirmation
		expect(requiresYesFlag(["--storage", "-y", "delete", "-n", "<id>"])).to.be.true;
	});

	it("requires --yes when --yes is value of -n, not a confirmation flag", () => {
		// --yes is the value for -n (notebook ID), so it should NOT count as confirmation
		expect(requiresYesFlag(["delete", "-n", "--yes"])).to.be.true;
	});

	it("requires --yes for source delete-by-title", () => {
		expect(requiresYesFlag(["source", "delete-by-title", "-n", "<id>"])).to.be.true;
	});

	it("accepts --yes for source delete-by-title", () => {
		expect(requiresYesFlag(["source", "delete-by-title", "-n", "<id>", "-y"])).to.be.false;
	});

	it("does not require --yes for skill uninstall (v0.7.3 does not support --yes)", () => {
		expect(requiresYesFlag(["skill", "uninstall"])).to.be.false;
	});

	it("does not require --yes for history --clear (v0.7.3 does not support --yes)", () => {
		expect(requiresYesFlag(["history", "--clear"])).to.be.false;
	});

	it("does not require --yes for history without --clear", () => {
		expect(requiresYesFlag(["history", "--json"])).to.be.false;
	});

	it("rejects --yes after -- (positional, not a real flag)", () => {
		expect(requiresYesFlag(["delete", "-n", "<id>", "--", "--yes"])).to.be.true;
	});

	it("rejects -y after -- (positional, not a real flag)", () => {
		expect(requiresYesFlag(["delete", "-n", "<id>", "--", "-y"])).to.be.true;
	});

	it("accepts --yes before --", () => {
		expect(requiresYesFlag(["delete", "-n", "<id>", "--yes", "--"])).to.be.false;
	});
});

// ---------------------------------------------------------------------------
// isBlockedInteractive
// ---------------------------------------------------------------------------

describe("isBlockedInteractive", () => {
	it("blocks login command", () => {
		const r = isBlockedInteractive(["login"]);
		expect(r.blocked).to.be.true;
		expect(r.message).to.include("terminal");
	});

	it("blocks login even with global options before it", () => {
		const r = isBlockedInteractive(["--profile", "work", "login"]);
		expect(r.blocked).to.be.true;
		expect(r.message).to.include("terminal");
	});

	it("blocks login after -- end-of-options marker", () => {
		const r = isBlockedInteractive(["--", "login"]);
		expect(r.blocked).to.be.true;
	});

	it("blocks login with --storage option", () => {
		const r = isBlockedInteractive(["--storage", "path.json", "login"]);
		expect(r.blocked).to.be.true;
	});

	it("allows other auth subcommands", () => {
		expect(isBlockedInteractive(["auth", "check", "--test", "--json"]).blocked).to.be.false;
		expect(isBlockedInteractive(["auth", "status"]).blocked).to.be.false;
	});

	it("allows non-auth commands", () => {
		expect(isBlockedInteractive(["list", "--json"]).blocked).to.be.false;
		expect(isBlockedInteractive(["delete", "-n", "<id>", "-y"]).blocked).to.be.false;
	});

	it("allows login --help (not blocked)", () => {
		expect(isBlockedInteractive(["login", "--help"]).blocked).to.be.false;
	});

	it("blocks login when --help is --storage value (not real help flag)", () => {
		const r = isBlockedInteractive(["--storage", "--help", "login"]);
		expect(r.blocked).to.be.true;
		expect(r.message).to.include("terminal");
	});

	it("blocks login with --help after -- (positional, not help)", () => {
		const r = isBlockedInteractive(["login", "--", "--help"]);
		expect(r.blocked).to.be.true;
		expect(r.message).to.include("terminal");
	});

	it("allows source clean --help (not blocked)", () => {
		expect(isBlockedInteractive(["source", "clean", "--help"]).blocked).to.be.false;
	});

	it("allows profile delete --help (not blocked)", () => {
		expect(isBlockedInteractive(["profile", "delete", "--help"]).blocked).to.be.false;
	});
});

// ---------------------------------------------------------------------------
// truncateOutput
// ---------------------------------------------------------------------------

describe("truncateOutput", () => {
	it("passes through small output unchanged", () => {
		const r = truncateOutput("hello world");
		expect(r.text.startsWith("hello world")).to.be.true;
		expect(r.truncated).to.be.false;
		expect(r.tempPath).to.be.undefined;
	});

	it("truncates by byte count (not character count)", () => {
		// 60 KB of ASCII characters
		const big = "x".repeat(60 * 1024);
		const r = truncateOutput(big);
		expect(r.truncated).to.be.true;
		expect(r.text).to.include("[truncated at 50 KB]");
		expect(r.text).to.include("Full output saved to:");
		expect(r.tempPath).to.be.ok;
		expect(existsSync(r.tempPath!)).to.be.true;
		const saved = readFileSync(r.tempPath!, "utf8");
		expect(saved.length).to.equal(60 * 1024);
	});

	it("truncates multi-byte UTF-8 at a safe character boundary", () => {
		// 3-byte CJK characters — 60KB chars would exceed 50KB bytes
		const cjk = "\u4e2d\u56fd".repeat(15 * 1024); // 30K chars ≈ 90KB
		const r = truncateOutput(cjk);
		expect(r.truncated).to.be.true;
		expect(r.text).to.include("[truncated at 50 KB]");
		// No replacement character at the boundary
		expect(r.text).not.to.include("\uFFFD");
	});

	it("truncates by line count", () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
		const big = lines.join("\n");
		const r = truncateOutput(big);
		expect(r.truncated).to.be.true;
		expect(r.text).to.include("[truncated at 2000 lines]");
		expect(r.text).to.include("Full output saved to:");
		expect(r.tempPath).to.be.ok;
	});

	it("handles empty string", () => {
		const r = truncateOutput("");
		expect(r.text).to.equal("");
		expect(r.truncated).to.be.false;
	});

	it("final output with suffix does not exceed 50 KB for dynamic temp path", () => {
		// Use a content that's right at the boundary such that even a long
		// temp path doesn't push the result over 50 KB
		const big = "x".repeat(51 * 1024);
		const r = truncateOutput(big);
		expect(r.truncated).to.be.true;
		expect(Buffer.byteLength(r.text, "utf8")).to.be.at.most(50 * 1024);
	});

	it("combined byte+line truncation does not exceed 2000 lines", () => {
		// 3000 lines of ~23 bytes each: ~69KB total, 3000 lines
		// After byte truncation to ~49.7KB, ~2160 lines remain (still above 2000)
		// so line truncation also fires. Final output must respect both limits.
		const big = Array.from({ length: 3000 }, (_, i) => "x".repeat(20) + String(i)).join("\n");
		const r = truncateOutput(big);
		expect(r.truncated).to.be.true;
		expect(r.text).to.include("[truncated at 50 KB]");
		expect(r.text).to.include("[truncated at 2000 lines]");
		expect(r.text.split("\n").length).to.be.at.most(2000);
		expect(Buffer.byteLength(r.text, "utf8")).to.be.at.most(50 * 1024);
	});

	it("final output with byte suffix does not exceed 50 KB", () => {
		const big = "x".repeat(50 * 1024 - 100); // just under 50 KB
		const r = truncateOutput(big);
		expect(r.truncated).to.be.false;
		expect(Buffer.byteLength(r.text, "utf8")).to.be.at.most(50 * 1024);
	});

	it("final output with line suffix does not exceed 2000 lines", () => {
		const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
		const big = lines.join("\n");
		const r = truncateOutput(big);
		expect(r.truncated).to.be.false;
		expect(r.text.split("\n").length).to.be.at.most(2000);
	});
});

// ---------------------------------------------------------------------------
// extractOutputPaths
// ---------------------------------------------------------------------------

describe("extractOutputPaths", () => {

	it("extracts -o flag path from source fulltext", () => {
		const paths = extractOutputPaths(["source", "fulltext", "<src>", "-o", "output.md"], "/cwd");
		expect(paths).to.deep.equal(["/cwd/output.md"]);
	});

	it("extracts --output flag path", () => {
		const paths = extractOutputPaths(["source", "fulltext", "<src>", "--output", "/abs/path.md"], "/cwd");
		expect(paths).to.deep.equal(["/abs/path.md"]);
	});

	it("extracts download positional path", () => {
		const paths = extractOutputPaths(["download", "audio", "output.mp3", "-a", "<id>"], "/cwd");
		expect(paths).to.deep.equal(["/cwd/output.mp3"]);
	});

	it("returns empty for no output path", () => {
		expect(extractOutputPaths(["list", "--json"], "/cwd")).to.deep.equal([]);
	});

	it("returns empty for source fulltext without -o", () => {
		expect(extractOutputPaths(["source", "fulltext", "<src>"], "/cwd")).to.deep.equal([]);
	});

	it("returns cwd fallback for download without explicit path arg", () => {
		const paths = extractOutputPaths(["download", "audio", "-a", "<id>"], "/cwd");
		expect(paths).to.deep.equal(["/cwd"]);
	});

	it("extracts download positional path when -a precedes path", () => {
		const paths = extractOutputPaths(["download", "audio", "-a", "<id>", "output.mp3"], "/cwd");
		expect(paths).to.deep.equal(["/cwd/output.mp3"]);
	});

	it("extracts download path with --force after flags", () => {
		const paths = extractOutputPaths(["download", "audio", "-a", "<id>", "output.mp3", "--force"], "/cwd");
		expect(paths).to.deep.equal(["/cwd/output.mp3"]);
	});

	it("deduplicates --all ./dir (single result)", () => {
		const paths = extractOutputPaths(["download", "audio", "--all", "./dir"], "/cwd");
		expect(paths).to.deep.equal(["/cwd/dir"]);
	});

	it("global options before download do not prevent path detection", () => {
		const paths = extractOutputPaths(["--profile", "work", "download", "audio", "out.mp3"], "/cwd");
		expect(paths).to.deep.equal(["/cwd/out.mp3"]);
	});

	it("global options before download with --all deduplicates", () => {
		const paths = extractOutputPaths(["--profile", "work", "download", "audio", "--all", "./dir"], "/cwd");
		expect(paths).to.deep.equal(["/cwd/dir"]);
	});

	it("global options before download without explicit path gets cwd fallback", () => {
		const paths = extractOutputPaths(["--profile", "work", "download", "audio", "-a", "<id>"], "/cwd");
		expect(paths).to.deep.equal(["/cwd"]);
	});
});

// ---------------------------------------------------------------------------
// Tool registration — mock pi
// ---------------------------------------------------------------------------

describe("tool registration", () => {
	let registered: any = null;

	const mockPi: any = {
		registerTool(def: any) {
			registered = def;
		},
	};

	beforeEach(() => {
		registered = null;
	});

	it("registers a tool named 'notebooklm'", async () => {
		const { default: ext } = await import("../index.js");
		ext(mockPi);
		expect(registered).to.be.ok;
		expect(registered.name).to.equal("notebooklm");
	});

	it("includes label and description", async () => {
		const { default: ext } = await import("../index.js");
		ext(mockPi);
		expect(registered.label).to.be.a("string");
		expect(registered.description).to.be.a("string");
		expect(registered.promptSnippet).to.be.a("string");
		expect(registered.promptGuidelines).to.be.an("array");
	});

	it("has a TypeBox parameters schema", async () => {
		const { default: ext } = await import("../index.js");
		ext(mockPi);
		expect(registered.parameters).to.be.ok;
		expect(registered.parameters.type).to.equal("object");
		expect(registered.parameters.properties?.args).to.be.ok;
		expect(registered.parameters.properties?.confirm).to.be.ok;
		expect(registered.parameters.properties?.timeout_ms).to.be.ok;
	});
});

// ---------------------------------------------------------------------------
// Tool execution — mock pi with controlled exec results
// ---------------------------------------------------------------------------

describe("tool execution", () => {
	let registered: any = null;
	let execResults: any[];
	let execCallCount: number;
	let capturedCwd: string | undefined;
	let capturedSignal: any;
	let capturedTimeout: number | undefined;
	let capturedCmd: string | undefined;
	let capturedArgs: string[] | undefined;

	const mockCtx: any = { cwd: "/test/cwd" };
	const mockSignal = { aborted: false };

	async function resetExtension() {
		execResults = [];
		execCallCount = 0;
		capturedCwd = undefined;
		capturedSignal = undefined;
		capturedTimeout = undefined;
		capturedCmd = undefined;
		capturedArgs = undefined;

		const mockPi: any = {
			registerTool(def: any) {
				registered = def;
			},
			exec(cmd: string, args: string[], opts?: any) {
				capturedCmd = cmd;
				capturedArgs = args;
				capturedCwd = opts?.cwd;
				capturedSignal = opts?.signal;
				capturedTimeout = opts?.timeout;
				const r = execResults[execCallCount] ?? { stdout: "", stderr: "", code: 0 };
				execCallCount++;
				return Promise.resolve(r);
			},
		};
		const { default: ext } = await import("../index.js");
		ext(mockPi);
	}

	beforeEach(async () => {
		await resetExtension();
	});

	it("rejects empty args", async () => {
		try {
			await registered.execute("id", { args: [], timeout_ms: 5000 }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("non-empty array");
		}
	});

	it("rejects login interactive command", async () => {
		try {
			await registered.execute("id", { args: ["login"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("terminal");
		}
	});

	it("rejects login with global option prefix", async () => {
		try {
			await registered.execute("id", { args: ["--profile", "work", "login"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("terminal");
		}
	});

	it("rejects login with -- bypass", async () => {
		try {
			await registered.execute("id", { args: ["--", "login"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("terminal");
		}
	});

	it("rejects destructive commands without confirm", async () => {
		try {
			await registered.execute("id", { args: ["delete", "-n", "<id>"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects clear without confirm", async () => {
		try {
			await registered.execute("id", { args: ["clear"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects ask --new without confirm", async () => {
		try {
			await registered.execute("id", { args: ["ask", "--new", "question"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects destructive command with -- bypass", async () => {
		try {
			await registered.execute("id", { args: ["--", "delete", "-n", "<id>"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects auth logout with -- bypass", async () => {
		try {
			await registered.execute("id", { args: ["--", "auth", "logout"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects destructive commands that need --yes even when confirm=true", async () => {
		try {
			await registered.execute(
				"id",
				{ args: ["delete", "-n", "<id>"], confirm: true },
				mockSignal,
				undefined,
				mockCtx,
			);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("--yes");
		}
	});

	it("allows destructive commands with confirm=true and -y", async () => {
		execResults.push({ stdout: "deleted", stderr: "", code: 0 });
		const r = await registered.execute(
			"id",
			{ args: ["delete", "-n", "<id>", "-y"], confirm: true },
			mockSignal,
			undefined,
			mockCtx,
		);
		expect(r.content[0].text).to.equal("deleted");
		expect(r.details.exitCode).to.equal(0);
	});

	it("allows ask --new with confirm=true and -y", async () => {
		execResults.push({ stdout: '{"answer":"ok"}', stderr: "", code: 0 });
		const r = await registered.execute(
			"id",
			{ args: ["ask", "--new", "-y", "question"], confirm: true },
			mockSignal,
			undefined,
			mockCtx,
		);
		expect(r.content[0].text).to.equal('{"answer":"ok"}');
		expect(r.details.exitCode).to.equal(0);
	});

	it("allows auth logout with confirm=true (no --yes needed)", async () => {
		execResults.push({ stdout: "Logged out", stderr: "", code: 0 });
		const r = await registered.execute(
			"id",
			{ args: ["auth", "logout"], confirm: true },
			mockSignal,
			undefined,
			mockCtx,
		);
		expect(r.content[0].text).to.equal("Logged out");
		expect(r.details.exitCode).to.equal(0);
	});

	it("allows clear with confirm=true (v0.7.3 does not support -y for clear)", async () => {
		execResults.push({ stdout: "Context cleared", stderr: "", code: 0 });
		const r = await registered.execute(
			"id",
			{ args: ["clear"], confirm: true },
			mockSignal,
			undefined,
			mockCtx,
		);
		expect(r.content[0].text).to.equal("Context cleared");
		expect(r.details.exitCode).to.equal(0);
	});

	it("passes exec with correct command and args", async () => {
		execResults.push({ stdout: '{"id":"n-123"}', stderr: "", code: 0 });
		await registered.execute("id", { args: ["list", "--json"] }, mockSignal, undefined, mockCtx);
		expect(capturedCmd).to.equal("notebooklm");
		expect(capturedArgs).to.deep.equal(["list", "--json"]);
		expect(capturedCwd).to.equal("/test/cwd");
		expect(capturedSignal).to.equal(mockSignal);
		expect(capturedTimeout).to.equal(60_000);
	});

	it("returns stderr-only success", async () => {
		execResults.push({ stdout: "", stderr: "info: done", code: 0 });
		const r = await registered.execute("id", { args: ["doctor", "--json"] }, mockSignal, undefined, mockCtx);
		expect(r.content[0].text).to.equal("info: done");
	});

	it("throws on non-zero exit", async () => {
		execResults.push({ stdout: "", stderr: "Auth expired", code: 1 });
		try {
			await registered.execute("id", { args: ["list", "--json"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("exit 1");
			expect(e.message).to.include("Auth expired");
		}
	});

	it("handles killed result before exit code (timeout)", async () => {
		execResults.push({ stdout: "", stderr: "", code: null, killed: true });
		try {
			await registered.execute("id", { args: ["list", "--json"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("cancelled");
			expect(e.message).to.include("timeout");
		}
	});

	it("handles killed result before exit code (interrupted)", async () => {
		execResults.push({ stdout: "", stderr: "", code: 143, killed: true });
		try {
			await registered.execute("id", { args: ["list", "--json"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("cancelled");
			expect(e.message).to.include("interrupted");
		}
	});

	it("truncates oversized output", async () => {
		const big = "x".repeat(60 * 1024);
		execResults.push({ stdout: big, stderr: "", code: 0 });
		const r = await registered.execute("id", { args: ["list", "--json"] }, mockSignal, undefined, mockCtx);
		expect(r.content[0].text).to.include("[truncated");
		expect(r.content[0].text).to.include("Full output saved to:");
		// Returned content must not exceed 50 KB even with suffix appended
		expect(Buffer.byteLength(r.content[0].text, "utf8")).to.be.at.most(50 * 1024);
		expect(r.details.truncated).to.be.true;
		expect(r.details.fullOutputPath).to.be.ok;
	});

	it("includes exit code in details, not large content", async () => {
		execResults.push({ stdout: "ok", stderr: "", code: 0 });
		const r = await registered.execute("id", { args: ["list"] }, mockSignal, undefined, mockCtx);
		expect(r.details.exitCode).to.equal(0);
		expect(r.details.truncated).to.be.undefined;
		expect(r.details.fullOutputPath).to.be.undefined;
		expect(r.content[0].text).to.equal("ok");
	});

	it("handles pi.exec throwing ENOENT", async () => {
		const mockPi2: any = {
			registerTool(def: any) {
				registered = def;
			},
			exec() {
				const err: any = new Error("spawn notebooklm ENOENT");
				err.code = "ENOENT";
				return Promise.reject(err);
			},
		};
		const { default: ext } = await import("../index.js");
		ext(mockPi2);

		try {
			await registered.execute("id", { args: ["list", "--json"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("notebooklm CLI not found in PATH");
		}
	});

	it("passes login --help (bypasses safety gates)", async () => {
		execResults.push({ stdout: "help text", stderr: "", code: 0 });
		const r = await registered.execute("id", { args: ["login", "--help"] }, mockSignal, undefined, mockCtx);
		expect(r.content[0].text).to.equal("help text");
	});

	it("passes source clean --help (bypasses destructive gate)", async () => {
		execResults.push({ stdout: "help text", stderr: "", code: 0 });
		const r = await registered.execute(
			"id",
			{ args: ["source", "clean", "--help"] },
			mockSignal,
			undefined,
			mockCtx,
		);
		expect(r.content[0].text).to.equal("help text");
	});

	it("rejects ask --new -- --help (--help after -- is positional)", async () => {
		try {
			await registered.execute(
				"id",
				{ args: ["ask", "--new", "-y", "--", "--help"] },
				mockSignal,
				undefined,
				mockCtx,
			);
			expect.fail("should have thrown requiring confirm");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects source delete-by-title -- --help (--help after -- is positional)", async () => {
		try {
			await registered.execute(
				"id",
				{ args: ["source", "delete-by-title", "-n", "<id>", "-y", "--", "--help"] },
				mockSignal,
				undefined,
				mockCtx,
			);
			expect.fail("should have thrown requiring confirm");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects source delete-by-title without confirm", async () => {
		try {
			await registered.execute(
				"id",
				{ args: ["source", "delete-by-title", "-n", "<id>"] },
				mockSignal,
				undefined,
				mockCtx,
			);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects skill uninstall without confirm", async () => {
		try {
			await registered.execute("id", { args: ["skill", "uninstall"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects history --clear without confirm", async () => {
		try {
			await registered.execute("id", { args: ["history", "--clear"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects share public --enable without confirm", async () => {
		try {
			await registered.execute("id", { args: ["share", "public", "--enable"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects share add without confirm", async () => {
		try {
			await registered.execute("id", { args: ["share", "add", "user@x.com"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects share update without confirm", async () => {
		try {
			await registered.execute(
				"id",
				{ args: ["share", "update", "user@x.com", "--permission", "editor"] },
				mockSignal,
				undefined,
				mockCtx,
			);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	it("rejects share view-level without confirm", async () => {
		try {
			await registered.execute("id", { args: ["share", "view-level", "full"] }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			expect(e.message).to.include("confirm: true");
		}
	});

	describe("file overwrite (--force) gate", () => {
		it("rejects download --force without confirm", async () => {
			try {
				await registered.execute(
					"id",
					{ args: ["download", "audio", "output.mp3", "-a", "<id>", "--force"] },
					mockSignal,
					undefined,
					mockCtx,
				);
				expect.fail("should have thrown");
			} catch (e: any) {
				expect(e.message).to.include("confirm: true");
			}
		});

		it("rejects source fulltext -o --force without confirm", async () => {
			try {
				await registered.execute(
					"id",
					{ args: ["source", "fulltext", "<src>", "-o", "output.md", "--force"] },
					mockSignal,
					undefined,
					mockCtx,
				);
				expect.fail("should have thrown");
			} catch (e: any) {
				expect(e.message).to.include("confirm: true");
			}
		});

		it("allows download --force with confirm=true", async () => {
			execResults.push({ stdout: "downloaded", stderr: "", code: 0 });
			const r = await registered.execute(
				"id",
				{ args: ["download", "audio", "output.mp3", "-a", "<id>", "--force"], confirm: true },
				mockSignal,
				undefined,
				mockCtx,
			);
			expect(r.content[0].text).to.equal("downloaded");
		});

		it("rejects skill install --force without confirm", async () => {
			try {
				await registered.execute(
					"id",
					{ args: ["skill", "install", "--scope", "project", "--force"] },
					mockSignal,
					undefined,
					mockCtx,
				);
				expect.fail("should have thrown");
			} catch (e: any) {
				expect(e.message).to.include("confirm: true");
			}
		});

		it("allows download without --force (not destructive)", async () => {
			execResults.push({ stdout: "ok", stderr: "", code: 0 });
			const r = await registered.execute(
				"id",
				{ args: ["download", "audio", "-a", "<id>"] },
				mockSignal,
				undefined,
				mockCtx,
			);
			expect(r.content[0].text).to.equal("ok");
		});
	});

	it("allows skill uninstall with confirm=true (v0.7.3 does not support -y)", async () => {
		execResults.push({ stdout: "uninstalled", stderr: "", code: 0 });
		const r = await registered.execute(
			"id",
			{ args: ["skill", "uninstall"], confirm: true },
			mockSignal,
			undefined,
			mockCtx,
		);
		expect(r.content[0].text).to.equal("uninstalled");
	});

	it("allows history --clear with confirm=true (v0.7.3 does not support -y)", async () => {
		execResults.push({ stdout: "cleared", stderr: "", code: 0 });
		const r = await registered.execute(
			"id",
			{ args: ["history", "--clear"], confirm: true },
			mockSignal,
			undefined,
			mockCtx,
		);
		expect(r.content[0].text).to.equal("cleared");
	});

	it("bounded args in error messages for large inline content", async () => {
		const bigArgs = ["ask", "x".repeat(5000)];
		try {
			await registered.execute("id", { args: bigArgs }, mockSignal, undefined, mockCtx);
			expect.fail("should have thrown");
		} catch (e: any) {
			// Gate error messages must show command path only, not raw content
			expect(Buffer.byteLength(e.message, "utf8")).to.be.below(2000);
			expect(e.message).not.to.include("x".repeat(100));
		}
	});

	it("bounded --yes required error does not echo full args", async () => {
		const bigArgs = ["ask", "--new", "x".repeat(5000)];
		try {
			await registered.execute(
				"id",
				{ args: bigArgs, confirm: true },
				mockSignal,
				undefined,
				mockCtx,
			);
			expect.fail("should have thrown");
		} catch (e: any) {
			// The --yes required branch should also have bounded, redacted args
			expect(Buffer.byteLength(e.message, "utf8")).to.be.below(2000);
			// Should show command path only, not the large inline content
			expect(e.message).to.include("ask");
			expect(e.message).not.to.include("x".repeat(100));
		}
	});
});
