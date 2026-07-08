import { describe, it } from "mocha";
import { expect } from "chai";

import { buildArgs } from "../lib/cli.js";

describe("buildArgs", () => {
	it("builds a simple command", () => {
		expect(buildArgs("read", { file: "My Note" })).to.deep.equal(["read", "file=My Note"]);
	});

	it("skips undefined and false values", () => {
		expect(buildArgs("search", { query: "test", limit: undefined, case_sensitive: false }))
			.to.deep.equal(["search", "query=test"]);
	});

	it("includes boolean flags", () => {
		expect(buildArgs("create", { name: "Test" }, ["silent", "overwrite"]))
			.to.deep.equal(["create", "name=Test", "silent", "overwrite"]);
	});

	it("passes boolean true as bare flag", () => {
		expect(buildArgs("search", { query: "test", matches: true, total: true }))
			.to.deep.equal(["search", "query=test", "matches", "total"]);
	});

	it("includes numeric values", () => {
		expect(buildArgs("search", { query: "test", limit: 10 }))
			.to.deep.equal(["search", "query=test", "limit=10"]);
	});

	it("splits multi-word commands by space", () => {
		expect(buildArgs("tags all", { counts: true }))
			.to.deep.equal(["tags", "all", "counts"]);
	});

	it("splits tasks subcommands", () => {
		expect(buildArgs("tasks daily", {}))
			.to.deep.equal(["tasks", "daily"]);
		expect(buildArgs("tasks file", { file: "test.md" }))
			.to.deep.equal(["tasks", "file", "file=test.md"]);
	});
});
