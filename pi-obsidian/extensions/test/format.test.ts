import { describe, it } from "mocha";
import { expect } from "chai";

import {
	formatSearchResults,
	formatTasks,
	formatTags,
	formatLinks,
	formatOutline,
	formatOutgoingLinks,
	formatFileInfo,
	formatProperties,
	formatAliases,
	formatWordCount,
} from "../lib/format.js";

describe("formatSearchResults", () => {
	it("returns empty message for null input", () => {
		expect(formatSearchResults(null)).to.equal("No results found.");
	});

	it("returns empty message for empty array", () => {
		expect(formatSearchResults([])).to.equal("No results found.");
	});

	it("formats search results with filenames", () => {
		const results = [
			{ filename: "Meetings/2024-01.md", match: "met with team" },
			{ filename: "Journal/2024-01-15.md", match: "team standup" },
		];
		const output = formatSearchResults(results);
		expect(output).to.include("Meetings/2024-01.md");
		expect(output).to.include("met with team");
		expect(output).to.include("Journal/2024-01-15.md");
		expect(output).to.include("team standup");
	});
});

describe("formatTasks", () => {
	it("formats todo tasks", () => {
		const tasks = [
			{ status: " ", text: "Buy groceries" },
			{ status: "x", text: "Done task", filename: "todo.md", line: 5 },
		];
		const output = formatTasks(tasks);
		expect(output).to.include("[ ] Buy groceries");
		expect(output).to.include("[x] Done task");
		expect(output).to.include("todo.md:5");
	});
});

describe("formatTags", () => {
	it("formats tags with counts", () => {
		const tags = [
			{ tag: "#project", count: 5 },
			{ tag: "#meeting", count: 3 },
		];
		const output = formatTags(tags);
		expect(output).to.include("#project: 5");
		expect(output).to.include("#meeting: 3");
	});
});

describe("formatLinks", () => {
	it("formats backlink results", () => {
		const links = [
			{ filename: "Journal/2024-01.md" },
			{ filename: "Projects/ideas.md" },
		];
		const output = formatLinks(links, "Backlinks");
		expect(output).to.include("Journal/2024-01.md");
		expect(output).to.include("Projects/ideas.md");
	});

	it("returns empty message for empty array", () => {
		expect(formatLinks([], "Backlinks")).to.equal("No backlinks.");
	});
});

describe("formatOutline", () => {
	it("formats heading tree", () => {
		const tree = [
			{ level: 1, heading: "Home", children: [
				{ level: 2, heading: "Start here" },
				{ level: 2, heading: "Key spaces" },
			]},
		];
		const output = formatOutline(tree);
		expect(output).to.include("# Home");
		expect(output).to.include("## Start here");
		expect(output).to.include("## Key spaces");
	});

	it("returns empty message for null", () => {
		expect(formatOutline(null)).to.equal("(no headings)");
	});
});

describe("formatOutgoingLinks", () => {
	it("formats outgoing links with broken marker", () => {
		const links = [
			{ link: "[[Note A]]" },
			{ link: "[[Broken]]", unresolved: true },
		];
		const output = formatOutgoingLinks(links);
		expect(output).to.include("[[Note A]]");
		expect(output).to.include("[[Broken]] (broken)");
	});

	it("returns empty message for empty", () => {
		expect(formatOutgoingLinks([])).to.equal("No outgoing links.");
	});
});

describe("formatProperties", () => {
	it("formats vault-wide property list", () => {
		const props = [
			{ name: "tags", count: 50 },
			{ name: "status", count: 30 },
		];
		const output = formatProperties(props);
		expect(output).to.include("tags: 50");
		expect(output).to.include("status: 30");
	});

	it("returns empty message for empty", () => {
		expect(formatProperties([])).to.equal("No properties found.");
	});
});

describe("formatFileInfo", () => {
	it("formats file info as key: value", () => {
		const info = { name: "test.md", size: 1024, created: "2024-01-01" };
		const output = formatFileInfo(info);
		expect(output).to.include("name: test.md");
		expect(output).to.include("size: 1024");
		expect(output).to.include("created: 2024-01-01");
	});
});

describe("formatAliases", () => {
	it("formats aliases list", () => {
		const aliases = [
			{ alias: "Schema", filename: "99 Meta/Frontmatter Schema.md" },
		];
		const output = formatAliases(aliases);
		expect(output).to.include("Schema");
	});
});

describe("formatWordCount", () => {
	it("formats word count object", () => {
		const wc = { words: 150, characters: 800 };
		const output = formatWordCount(wc);
		expect(output).to.include("words: 150");
		expect(output).to.include("characters: 800");
	});
});
