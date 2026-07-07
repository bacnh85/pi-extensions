import { describe, it } from "mocha";
import { expect } from "chai";

import {
	formatSearchResults,
	formatTasks,
	formatTags,
	formatLinks,
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


