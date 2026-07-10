/**
 * Unit tests for pi-plan bash gating (isReadOnlyBash).
 */

import { isReadOnlyBash, isDestructiveBash } from "./lib/bash-gating";
import { DEFAULT_PLAN_TOOLS, MUNIN_PLAN_TOOLS, SERENA_PLAN_TOOLS, WEB_PLAN_TOOLS } from "./lib/plan-tools";
import { PLAN_MODE_SERENA_GUIDANCE } from "./lib/guidance";
import { expect } from "chai";

describe("plan-mode guidance", () => {
	it("tells agents to use Serena before raw code reads/searches", () => {
		expect(PLAN_MODE_SERENA_GUIDANCE).to.include("use Serena before raw reads/searches");
		expect(PLAN_MODE_SERENA_GUIDANCE).to.include("serena_get_symbols_overview");
		expect(PLAN_MODE_SERENA_GUIDANCE).to.include("serena_find_symbol");
		expect(PLAN_MODE_SERENA_GUIDANCE).to.include("Use read for docs/config/non-code files");
	});
});

describe("plan-mode tool allowlist", () => {
	it("includes all unified pi-web v0.4 tools", () => {
		expect(WEB_PLAN_TOOLS).to.include.members([
			"web_search",
			"web_extract",
			"web_map",
			"web_crawl",
			"web_screenshot",
			"web_pdf",
			"web_status",
		]);
		expect(DEFAULT_PLAN_TOOLS).to.include.members(WEB_PLAN_TOOLS);
	});

	it("does not include removed pi-web v0.3 tool names", () => {
		expect(DEFAULT_PLAN_TOOLS).not.to.include.members([
			"searxng_search",
			"brave_search",
			"brave_content",
			"firecrawl_search",
			"firecrawl_scrape",
			"firecrawl_map",
			"firecrawl_crawl",
		]);
	});

	it("includes only read-only Serena tools for planning", () => {
		expect(SERENA_PLAN_TOOLS).to.include.members([
			"serena_status",
			"serena_list_tools",
			"serena_get_symbols_overview",
			"serena_find_symbol",
			"serena_find_declaration",
			"serena_find_implementations",
			"serena_find_referencing_symbols",
			"serena_search_for_pattern",
			"serena_get_diagnostics_for_file",
		]);
		expect(DEFAULT_PLAN_TOOLS).to.include.members(SERENA_PLAN_TOOLS);
		expect(DEFAULT_PLAN_TOOLS).not.to.include.members([
			"serena_replace_symbol_body",
			"serena_insert_before_symbol",
			"serena_insert_after_symbol",
			"serena_rename_symbol",
			"serena_safe_delete_symbol",
			"serena_replace_content",
			"serena_write_memory",
			"serena_edit_memory",
			"serena_rename_memory",
			"serena_delete_memory",
		]);
	});

	it("includes only read-only Munin tools for planning", () => {
		expect(MUNIN_PLAN_TOOLS).to.include.members([
			"munin_search",
			"munin_get",
			"munin_list",
			"munin_recent",
			"munin_capabilities",
		]);
		expect(DEFAULT_PLAN_TOOLS).to.include.members(MUNIN_PLAN_TOOLS);
		expect(DEFAULT_PLAN_TOOLS).not.to.include.members([
			"munin_store",
			"munin_capture",
			"munin_batch_store",
			"munin_delete",
			"munin_rollback",
			"munin_share",
			"munin_acknowledge_setup",
			"munin_encrypt",
			"munin_decrypt",
			"munin_export",
		]);
	});
});

describe("isReadOnlyBash", () => {
	// --- git commands ---

	it("allows git status with -- flag separator", () => {
		expect(isReadOnlyBash("git status --short -- path/to/dir")).to.be.true;
	});

	it("allows git status with -- and multiple paths", () => {
		expect(isReadOnlyBash("git status --short -- extensions/pi-review/ extensions/pi-plan/")).to.be.true;
	});

	it("allows git status without -- separator", () => {
		expect(isReadOnlyBash("git status --short")).to.be.true;
		expect(isReadOnlyBash("git status -s")).to.be.true;
		expect(isReadOnlyBash("git status --porcelain")).to.be.true;
	});

	it("allows git log with -- separator and --grep", () => {
		expect(isReadOnlyBash('git log --all --oneline --grep="serena" -- extensions/pi-plan/')).to.be.true;
	});

	it("allows git log with common flags", () => {
		expect(isReadOnlyBash("git log --oneline -5")).to.be.true;
		expect(isReadOnlyBash("git log --oneline --grep=pattern")).to.be.true;
	});

	it("allows git diff", () => {
		expect(isReadOnlyBash("git diff")).to.be.true;
		expect(isReadOnlyBash("git diff --stat")).to.be.true;
		expect(isReadOnlyBash("git diff HEAD~3 HEAD -- package.json")).to.be.true;
	});

	it("allows git show", () => {
		expect(isReadOnlyBash("git show HEAD -- package.json")).to.be.true;
	});

	it("allows git branch (read-only)", () => {
		expect(isReadOnlyBash("git branch --show-current")).to.be.true;
		expect(isReadOnlyBash("git branch -a")).to.be.true;
	});

	it("allows rev-parse and ls-files", () => {
		expect(isReadOnlyBash("git rev-parse --show-toplevel")).to.be.true;
		expect(isReadOnlyBash("git ls-files")).to.be.true;
	});

	it("blocks destructive git commands", () => {
		expect(isReadOnlyBash("git add .")).to.be.false;
		expect(isReadOnlyBash("git commit -m 'msg'")).to.be.false;
		expect(isReadOnlyBash("git push origin main")).to.be.false;
		expect(isReadOnlyBash("git checkout -b new-branch")).to.be.false;
		expect(isReadOnlyBash("git reset --hard")).to.be.false;
		expect(isReadOnlyBash("git stash")).to.be.false;
		expect(isReadOnlyBash("git merge feature")).to.be.false;
	});

	// --- chaining with && and ; ---

	it("allows && chaining of read-only commands", () => {
		expect(isReadOnlyBash("ls path && git status --short")).to.be.true;
		expect(isReadOnlyBash("ls path && grep pattern file.ts")).to.be.true;
	});

	it("allows ; chaining of read-only commands", () => {
		expect(isReadOnlyBash("echo start ; git status --short ; echo done")).to.be.true;
	});

	it("allows mixed && and ; chaining", () => {
		expect(isReadOnlyBash("cd /tmp && ls ; echo done")).to.be.true;
	});

	it("allows chaining with pipes inside chain segments", () => {
		expect(isReadOnlyBash("ls | grep test && cat file.ts")).to.be.true;
	});

	it("blocks && chaining when a segment is destructive", () => {
		expect(isReadOnlyBash("ls path && rm -rf /")).to.be.false;
		expect(isReadOnlyBash("cat file && git add .")).to.be.false;
	});

	// --- cd prefix stripping ---

	it("strips cd && prefix and validates the rest", () => {
		expect(isReadOnlyBash("cd /tmp && ls")).to.be.true;
		expect(isReadOnlyBash("cd /path/to/dir && git status")).to.be.true;
	});

	it("strips cd ; prefix and validates the rest", () => {
		expect(isReadOnlyBash("cd /tmp ; ls")).to.be.true;
	});

	it("strips cd && with quoted paths", () => {
		expect(isReadOnlyBash('cd "C:\\Program Files" && ls')).to.be.true;
	});

	// --- echo command ---

	it("allows echo", () => {
		expect(isReadOnlyBash('echo "test"')).to.be.true;
		expect(isReadOnlyBash("echo hello world")).to.be.true;
		expect(isReadOnlyBash("echo ---")).to.be.true;
	});

	it("allows echo in chains", () => {
		expect(isReadOnlyBash("echo start ; echo middle ; echo end")).to.be.true;
		expect(isReadOnlyBash("ls && echo done")).to.be.true;
	});

	// --- pipes ---

	it("allows pipes between read-only commands", () => {
		expect(isReadOnlyBash("ls | grep pattern")).to.be.true;
		expect(isReadOnlyBash("cat file.ts | head -5")).to.be.true;
		expect(isReadOnlyBash("rg pattern src/ | wc -l")).to.be.true;
	});

	// --- security blocks ---

	it("blocks shell metacharacters", () => {
		expect(isReadOnlyBash("ls $(dangerous)")).to.be.false;
		expect(isReadOnlyBash("ls `dangerous`")).to.be.false;
		expect(isReadOnlyBash("ls || rm -rf /")).to.be.false;
	});

	it("blocks interpreter commands", () => {
		expect(isReadOnlyBash("node script.js")).to.be.false;
		expect(isReadOnlyBash("python3 script.py")).to.be.false;
		expect(isReadOnlyBash("sh -c 'dangerous'")).to.be.false;
	});

	it("blocks npm non-metadata commands", () => {
		expect(isReadOnlyBash("npm install")).to.be.false;
		expect(isReadOnlyBash("npm test")).to.be.false;
		expect(isReadOnlyBash("npm run build")).to.be.false;
		expect(isReadOnlyBash("npm pack mocha")).to.be.false;
		expect(isReadOnlyBash("npm pack mocha --dry-run --json")).to.be.false;
		expect(isReadOnlyBash("npm pack mocha --ignore-scripts --json")).to.be.false;
	});

	it("allows npm metadata commands", () => {
		expect(isReadOnlyBash("npm view mocha")).to.be.true;
		expect(isReadOnlyBash("npm info typescript version")).to.be.true;
	});

	it("allows npm pack only as dry-run with scripts disabled", () => {
		expect(isReadOnlyBash("npm pack mocha --dry-run --json --ignore-scripts")).to.be.true;
		expect(isReadOnlyBash("npm pack @scope/pkg@1.2.3 --dry-run --ignore-scripts --registry https://registry.npmjs.org")).to.be.true;
	});

	// --- simple read-only commands ---

	it("allows simple read-only commands", () => {
		expect(isReadOnlyBash("ls")).to.be.true;
		expect(isReadOnlyBash("pwd")).to.be.true;
		expect(isReadOnlyBash("which node")).to.be.true;
		expect(isReadOnlyBash("cat file.ts")).to.be.true;
		expect(isReadOnlyBash("head -20 file.ts")).to.be.true;
		expect(isReadOnlyBash("rg pattern src/")).to.be.true;
		expect(isReadOnlyBash("grep -rn pattern src/")).to.be.true;
		expect(isReadOnlyBash("find . -name '*.ts'")).to.be.true;
		expect(isReadOnlyBash("wc -l file.ts")).to.be.true;
		expect(isReadOnlyBash("sort file.ts")).to.be.true;
	});

	// --- empty / trivial ---

	it("handles empty and trivial commands", () => {
		expect(isReadOnlyBash("")).to.be.true;
		expect(isReadOnlyBash("   ")).to.be.true;
	});
});

describe("isDestructiveBash (false-positive prevention)", () => {
	it("does not flag 'kill' in paths or arguments", () => {
		expect(isDestructiveBash("ls /bin/kill")).to.be.false;
		expect(isDestructiveBash("type kill")).to.be.false;
		expect(isDestructiveBash("which pkill")).to.be.false;
		expect(isDestructiveBash("grep -r kill src/")).to.be.false;
	});

	it("does not flag 'rm'/'mv'/'cp' in paths or arguments", () => {
		expect(isDestructiveBash("ls /usr/bin/rm")).to.be.false;
		expect(isDestructiveBash("cat src/rm-old/file.ts")).to.be.false;
		expect(isDestructiveBash("grep -r cp src/")).to.be.false;
		expect(isDestructiveBash("ls -la /bin/mv")).to.be.false;
	});

	it("does not flag 'sudo' in paths or arguments", () => {
		expect(isDestructiveBash("ls /usr/bin/sudo")).to.be.false;
		expect(isDestructiveBash("grep sudo /etc/sudoers")).to.be.false;
	});

	it("does not flag 2>&1 fd redirects", () => {
		expect(isDestructiveBash("ls 2>&1")).to.be.false;
		expect(isDestructiveBash("cat file.ts 2>&1")).to.be.false;
	});

	it("does flag file redirects", () => {
		expect(isDestructiveBash("ls > output.txt")).to.be.true;
		expect(isDestructiveBash("echo test > file")).to.be.true;
		expect(isDestructiveBash("cmd 2> error.log")).to.be.true;
	});

	it("does flag destructive commands", () => {
		expect(isDestructiveBash("rm -rf /")).to.be.true;
		expect(isDestructiveBash("kill 1234")).to.be.true;
		expect(isDestructiveBash("sudo rm -rf /")).to.be.true;
		expect(isDestructiveBash("mv old new")).to.be.true;
		expect(isDestructiveBash("cp /etc/passwd /tmp")).to.be.true;
		expect(isDestructiveBash("npm install")).to.be.true;
		expect(isDestructiveBash("git push origin main")).to.be.true;
	});

	it("does flag destructive commands in chained contexts", () => {
		expect(isDestructiveBash("ls && rm -rf /")).to.be.true;
		expect(isDestructiveBash("cat file ; sudo echo test")).to.be.true;
	});
});
