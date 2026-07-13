/**
 * Unit tests for pi-serena detection logic.
 */

import { expect } from "chai";
import {
	pathLooksLikeCode,
	pathLooksNonSemantic,
	commandLooksLikeSemanticCodeSearch,
} from "./lib/detect";
import { SEMANTIC_MISS_THRESHOLD } from "./lib/detect";
import { SERENA_FIRST_GUIDANCE, SERENA_MISS_GUIDANCE, shouldBlockSemanticMiss } from "./lib/guidance";
import { normalizeTimeoutMs, stripControlParams } from "./lib/normalize";

describe("Serena tool-selection guidance", () => {
	it("uses procedural Serena-first wording", () => {
		const guidance = SERENA_FIRST_GUIDANCE;
		expect(guidance).to.include("before reading whole code files");
		expect(guidance).to.include("serena_get_symbols_overview");
		expect(guidance).to.include("serena_find_symbol");
		expect(guidance).to.include("Use read/grep/find for docs, configs, non-code files");
	});

	it("detects strict-mode semantic misses for code reads and code searches", () => {
		expect(shouldBlockSemanticMiss("read", { path: "src/index.ts" })).to.be.true;
		expect(shouldBlockSemanticMiss("bash", { command: "rg 'class Foo' src/**/*.ts" })).to.be.true;
	});

	it("permits docs/config/non-code reads", () => {
		expect(shouldBlockSemanticMiss("read", { path: "README.md" })).to.be.false;
		expect(shouldBlockSemanticMiss("read", { path: "package.json" })).to.be.false;
		expect(shouldBlockSemanticMiss("bash", { command: "rg 'install' README.md" })).to.be.false;
	});
});

describe("SEMANTIC_MISS_THRESHOLD", () => {
	it("is 2, not the old threshold of 4", () => {
		// Changed from 4 to 2 so the agent gets a reminder sooner
		expect(SEMANTIC_MISS_THRESHOLD).to.equal(2);
	});
});

// ponytail: .spec.ts/.test.ts etc are covered by .ts — see pathLooksLikeCode uses lastIndexOf(".")
describe("pathLooksLikeCode", () => {
	const codeCases = [
		["src/index.ts", ".ts"],
		["src/main.py", ".py"],
		["src/main.go", ".go"],
		["src/app.js", ".js"],
		["src/Component.tsx", ".tsx"],
		["src/Component.jsx", ".jsx"],
		["src/Component.spec.ts", ".spec.ts (covered by .ts)"],
		["src/util.test.ts", ".test.ts (covered by .ts)"],
		["some-module.cjs", ".cjs"],
	];
	for (const [path, label] of codeCases) {
		it(`returns true for ${label}`, () => {
			expect(pathLooksLikeCode(path)).to.be.true;
		});
	}

	it("returns false for empty string", () => {
		expect(pathLooksLikeCode("")).to.be.false;
	});

	it("returns false for non-string values", () => {
		expect(pathLooksLikeCode(null)).to.be.false;
		expect(pathLooksLikeCode(undefined)).to.be.false;
		expect(pathLooksLikeCode(42)).to.be.false;
	});

	it("returns false for blank path", () => {
		expect(pathLooksLikeCode("  ")).to.be.false;
	});

	it("ignores query strings", () => {
		expect(pathLooksLikeCode("src/index.ts?foo=bar")).to.be.true;
	});

	it("ignores fragment identifiers", () => {
		expect(pathLooksLikeCode("src/index.ts#L42")).to.be.true;
	});
});

describe("pathLooksNonSemantic", () => {
	const nonSemCases = [
		["README.md", ".md"],
		["package.json", ".json"],
		[".serena/project.yml", ".yml"],
		["notes.txt", ".txt"],
		["data.csv", ".csv"],
		["server.log", ".log"],
		[".env", ".env"],
		["config.toml", ".toml"],
		[".editorconfig", ".editorconfig"],
		[".gitignore", ".gitignore"],
	];
	for (const [path, label] of nonSemCases) {
		it(`returns true for ${label}`, () => {
			expect(pathLooksNonSemantic(path)).to.be.true;
		});
	}

	it("returns false for .ts source files", () => {
		expect(pathLooksNonSemantic("src/index.ts")).to.be.false;
	});

	it("returns false for .py source files", () => {
		expect(pathLooksNonSemantic("src/main.py")).to.be.false;
	});
});

describe("commandLooksLikeSemanticCodeSearch", () => {
	const trueCases = [
		"grep -r 'class Foo' src/",
		"rg 'function validate' src/",
		"grep -rn 'def run' src/",
		"rg 'references' src/ --type ts",
		"find . -name '*.ts' | xargs grep 'interface'",
		"rg 'doSomething' src/**/*.ts",
		"grep 'error' *.py",
	];
	for (const cmd of trueCases) {
		it(`returns true for: ${cmd}`, () => {
			expect(commandLooksLikeSemanticCodeSearch(cmd)).to.be.true;
		});
	}

	const falseCases = [
		["ls -la", "no rg/grep/fd/find"],
		["cat file.ts", "no rg/grep/fd/find"],
		["node script.js", "no rg/grep/fd/find"],
		["rg 'TODO' AGENTS.md", "non-code target"],
		["grep 'version' package.json", "non-code target"],
		["grep 'description' SKILL.md", "non-code target"],
		["rg 'install' README.md", "non-code target"],
		["grep 'name' package.json", "non-code target"],
		["rg 'TODO' src/", "TODO pattern"],
		["grep -rn 'FIXME' src/", "TODO pattern"],
		["rg 'HACK' src/", "HACK pattern"],
		["grep 'NOTE' src/", "NOTE pattern"],
		["rg 'XXX' src/", "XXX pattern"],
		["grep -r 'BUG' src/", "BUG pattern"],
		["rg 'WORKAROUND' src/", "WORKAROUND pattern"],
		["rg 'TODO.*method' src/", "TODO still triggers exclusion"],
	];
	for (const [cmd, label] of falseCases) {
		it(`returns false for ${label}: ${cmd}`, () => {
			expect(commandLooksLikeSemanticCodeSearch(cmd)).to.be.false;
		});
	}
});

describe("normalizeTimeoutMs", () => {
	it("returns undefined for non-number non-string", () => {
		expect(normalizeTimeoutMs(null)).to.be.undefined;
		expect(normalizeTimeoutMs(undefined)).to.be.undefined;
		expect(normalizeTimeoutMs(true)).to.be.undefined;
		expect(normalizeTimeoutMs({})).to.be.undefined;
	});

	it("returns undefined for <= 0 numbers", () => {
		expect(normalizeTimeoutMs(0)).to.be.undefined;
		expect(normalizeTimeoutMs(-1)).to.be.undefined;
	});

	it("returns the number for positive finite numbers", () => {
		expect(normalizeTimeoutMs(5000)).to.equal(5000);
		expect(normalizeTimeoutMs(120000)).to.equal(120000);
	});

	it("parses numeric strings", () => {
		expect(normalizeTimeoutMs("5000")).to.equal(5000);
		expect(normalizeTimeoutMs("120000")).to.equal(120000);
	});

	it("returns undefined for non-numeric strings", () => {
		expect(normalizeTimeoutMs("abc")).to.be.undefined;
		expect(normalizeTimeoutMs("")).to.be.undefined;
		expect(normalizeTimeoutMs("0")).to.be.undefined;
		expect(normalizeTimeoutMs("-5")).to.be.undefined;
	});

	it("returns Infinity for Infinity", () => {
		expect(normalizeTimeoutMs(Infinity)).to.be.undefined;
	});
});

describe("stripControlParams", () => {
	it("extracts control params and leaves tool params", () => {
		const result = stripControlParams({ project: "/p", context: "c", timeout_ms: 5000, relative_path: "src/index.ts" });
		expect(result).to.deep.equal({ project: "/p", context: "c", timeoutMs: 5000, params: { relative_path: "src/index.ts" } });
	});

	it("pattern is removed when renamed to substring_pattern", () => {
		// This mirrors the search_for_pattern execute handler's mapping logic.
		const params: Record<string, unknown> = { pattern: "foo", relative_path: "src/" };
		if (params.pattern) {
			params.substring_pattern = params.pattern;
			delete params.pattern;
		}
		expect(params).to.have.property("substring_pattern", "foo");
		expect(params).to.not.have.property("pattern");
		expect(params).to.have.property("relative_path", "src/");
	});
});

