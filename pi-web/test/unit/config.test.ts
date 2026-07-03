/**
 * Unit tests for pi-web config module.
 */

import { expect } from "chai";
import {
	stripInlineComment,
	parseDotenvValue,
	parseDotenvFile,
	piConfigDirs,
	envFileCandidates,
	findEnvValue,
	normalizeSearxngBaseUrl,
	normalizeFirecrawlBaseUrl,
	normalizeCrawl4aiApiUrl,
	loadCrawl4aiConfig,
	DEFAULT_SEARXNG_BASE_URL,
	DEFAULT_CRAWL4AI_API_URL,
	HOSTED_FIRECRAWL_BASE_URL,
	OUTPUT_MAX_BYTES,
	OUTPUT_MAX_LINES,
} from "../../lib/config";

describe("stripInlineComment", () => {
	it("returns full value when no comment", () => {
		expect(stripInlineComment("hello")).to.equal("hello");
		expect(stripInlineComment("")).to.equal("");
	});

	it("strips comment after space", () => {
		expect(stripInlineComment("hello # world")).to.equal("hello ");
		expect(stripInlineComment("value #comment")).to.equal("value ");
	});

	it("preserves # inside single quotes", () => {
		expect(stripInlineComment("'hello # world'")).to.equal("'hello # world'");
	});

	it("preserves # inside double quotes", () => {
		expect(stripInlineComment('"hello # world"')).to.equal('"hello # world"');
	});

	it("handles escaped characters inside quotes", () => {
		expect(stripInlineComment('"hello \\" world" # comment')).to.equal(
			'"hello \\" world" ',
		);
	});

	it("strips comment when # is first character", () => {
		expect(stripInlineComment("# comment")).to.equal("");
	});

	it("handles mixed quoted and unquoted content", () => {
		expect(stripInlineComment("key='val' # comment")).to.equal("key='val' ");
	});

	it("handles escaped # with backslash", () => {
		expect(stripInlineComment("hello \\# not a comment")).to.equal(
			"hello \\# not a comment",
		);
	});
});

describe("parseDotenvValue", () => {
	it("trims and returns unquoted value", () => {
		expect(parseDotenvValue("  hello  ")).to.equal("hello");
	});

	it("strips double quotes", () => {
		expect(parseDotenvValue('"hello"')).to.equal("hello");
	});

	it("strips single quotes", () => {
		expect(parseDotenvValue("'hello'")).to.equal("hello");
	});

	it("handles escape sequences in double-quoted values", () => {
		expect(parseDotenvValue('"hello\\nworld"')).to.equal("hello\nworld");
		expect(parseDotenvValue('"path\\tto\\truby"')).to.equal("path\tto\truby");
	});

	it("trims whitespace in unquoted values", () => {
		expect(parseDotenvValue("  hello world  ")).to.equal("hello world");
	});

	it("refuses to remove double quotes from single-quoted value", () => {
		expect(parseDotenvValue("'hello\"'")).to.equal('hello"');
	});

	it("strips inline comment from unquoted value", () => {
		expect(parseDotenvValue("hello # comment")).to.equal("hello");
	});
});

describe("parseDotenvFile", () => {
	it("returns null for non-existent file", () => {
		const result = parseDotenvFile("/tmp/nonexistent-file-12345.env");
		expect(result).to.be.null;
	});

	it("parses a simple env file content via temp testing", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const tmpDir = fs.mkdtempSync("/tmp/pi-web-test-");
		const testFile = path.join(tmpDir, ".env");
		fs.writeFileSync(
			testFile,
			"FOO=bar\nBAZ=qux # inline comment\n# FULL LINE COMMENT\nEMPTY=\n",
			"utf8",
		);
		try {
			const result = parseDotenvFile(testFile);
			expect(result).to.deep.equal({ FOO: "bar", BAZ: "qux", EMPTY: "" });
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("piConfigDirs", () => {
	const origEnv = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		if (origEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = origEnv;
		}
	});

	it("returns custom dir when PI_CODING_AGENT_DIR is set", () => {
		process.env.PI_CODING_AGENT_DIR = "/custom/pi";
		const dirs = piConfigDirs();
		expect(dirs).to.deep.equal(["/custom/pi"]);
	});

	it("returns default dir when PI_CODING_AGENT_DIR is not set", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const dirs = piConfigDirs();
		expect(dirs).to.have.length(1);
		expect(dirs[0]).to.include(".pi/agent");
	});
});

describe("envFileCandidates", () => {
	it("includes cwd files and pi config dirs", () => {
		const candidates = envFileCandidates("/test/project", true);
		expect(candidates[0]).to.equal("/test/project/.env.local");
		expect(candidates[1]).to.equal("/test/project/.env");
	});

	it("omits cwd files when includeCwd is false", () => {
		const candidates = envFileCandidates("/test/project", false);
		expect(candidates[0]).not.to.include("/test/project");
	});

	it("returns pi config dir entries", () => {
		const candidates = envFileCandidates("/test/project", true);
		expect(candidates.length).to.be.at.least(2); // cwd .env.local, cwd .env
	});
});

describe("normalizeSearxngBaseUrl", () => {
	it("returns default when nothing provided", () => {
		expect(normalizeSearxngBaseUrl()).to.equal(DEFAULT_SEARXNG_BASE_URL);
	});

	it("preserves full URL with scheme", () => {
		expect(normalizeSearxngBaseUrl("https://search.example.com")).to.equal(
			"https://search.example.com",
		);
	});

	it("adds http for localhost", () => {
		expect(normalizeSearxngBaseUrl("localhost:8888")).to.equal(
			"http://localhost:8888",
		);
	});

	it("adds http for private IP", () => {
		expect(normalizeSearxngBaseUrl("192.168.1.1:8888")).to.equal(
			"http://192.168.1.1:8888",
		);
	});

	it("adds https for public hostname", () => {
		expect(normalizeSearxngBaseUrl("search.example.com")).to.equal(
			"https://search.example.com",
		);
	});

	it("removes trailing slashes", () => {
		expect(normalizeSearxngBaseUrl("http://localhost:8888/")).to.equal(
			"http://localhost:8888",
		);
	});
});

describe("normalizeFirecrawlBaseUrl", () => {
	it("returns hosted default when nothing provided", () => {
		expect(normalizeFirecrawlBaseUrl()).to.equal(HOSTED_FIRECRAWL_BASE_URL);
	});

	it("appends /v2 if no version segment", () => {
		expect(
			normalizeFirecrawlBaseUrl("http://localhost:3002"),
		).to.equal("http://localhost:3002/v2");
	});

	it("preserves existing version segment", () => {
		expect(
			normalizeFirecrawlBaseUrl("http://localhost:3002/v1"),
		).to.equal("http://localhost:3002/v1");
	});

	it("removes trailing slash before appending version", () => {
		expect(
			normalizeFirecrawlBaseUrl("http://localhost:3002/"),
		).to.equal("http://localhost:3002/v2");
	});
});

describe("findEnvValue", () => {
	it("reads from process.env first", () => {
		process.env.TEST_PI_WEB_VAR = "from_process";
		try {
			const result = findEnvValue("TEST_PI_WEB_VAR", "/tmp", false);
			expect(result.value).to.equal("from_process");
			expect(result.source).to.equal("process.env");
		} finally {
			delete process.env.TEST_PI_WEB_VAR;
		}
	});

	it("returns undefined when not found", () => {
		const result = findEnvValue("THIS_VAR_DOES_NOT_EXIST_12345", "/tmp", false);
		expect(result.value).to.be.undefined;
		expect(result.source).to.equal("");
	});
});

describe("normalizeCrawl4aiApiUrl", () => {
	it("returns default when nothing provided", () => {
		expect(normalizeCrawl4aiApiUrl()).to.equal(DEFAULT_CRAWL4AI_API_URL);
	});

	it("preserves full URL with scheme", () => {
		expect(normalizeCrawl4aiApiUrl("https://crawl.example.com")).to.equal(
			"https://crawl.example.com",
		);
	});

	it("adds http for private IP", () => {
		expect(normalizeCrawl4aiApiUrl("172.30.55.22:11235")).to.equal(
			"http://172.30.55.22:11235",
		);
	});

	it("adds https for public hostname", () => {
		expect(normalizeCrawl4aiApiUrl("crawl.example.com")).to.equal(
			"https://crawl.example.com",
		);
	});

	it("removes trailing slashes", () => {
		expect(normalizeCrawl4aiApiUrl("http://localhost:11235/")).to.equal(
			"http://localhost:11235",
		);
	});

	it("does not append /v2 like Firecrawl", () => {
		expect(normalizeCrawl4aiApiUrl("http://localhost:11235")).to.equal(
			"http://localhost:11235",
		);
	});
});

describe("loadCrawl4aiConfig", () => {
	it("returns default config from defaults", () => {
		const config = loadCrawl4aiConfig({}, "/tmp", false);
		expect(config.baseUrl).to.equal(DEFAULT_CRAWL4AI_API_URL);
		expect(config.timeoutMs).to.equal(60000);
	});

	it("accepts explicit API URL from params", () => {
		const config = loadCrawl4aiConfig(
			{ crawl4ai_api_url: "http://custom:12345" },
			"/tmp",
			false,
		);
		expect(config.baseUrl).to.equal("http://custom:12345");
	});

	it("accepts explicit API token from params", () => {
		const config = loadCrawl4aiConfig(
			{ crawl4ai_api_token: "my-token" },
			"/tmp",
			false,
		);
		expect(config.apiToken).to.equal("my-token");
	});

	it("reads timeout from params", () => {
		const config = loadCrawl4aiConfig({ timeout_ms: 30000 }, "/tmp", false);
		expect(config.timeoutMs).to.equal(30000);
	});

	it("throws on invalid timeout", () => {
		expect(() => loadCrawl4aiConfig({ timeout_ms: 500 }, "/tmp", false)).to.throw();
	});
});
