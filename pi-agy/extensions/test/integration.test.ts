import { describe, it, before, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as path from "node:path";
import * as url from "node:url";
import { createRequire } from "node:module";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const _require = createRequire(import.meta.url);

describe("agy_execute tool integration", function () {
	this.timeout(60_000);

	let piAgyExtension: any;
	let registeredTool: any = null;

	before(async () => {
		const mod = await import("../index.js");
		piAgyExtension = mod.default;
	});

	beforeEach(() => {
		registeredTool = null;
	});

	it("registers the tool with correct metadata", () => {
		const mockPi: any = {
			registerTool(def: any) {
				registeredTool = def;
			},
		};
		piAgyExtension(mockPi);
		expect(registeredTool).to.exist;
		expect(registeredTool.name).to.equal("agy_execute");
		const params = registeredTool.parameters;
		expect(params.properties).to.have.property("prompt");
		expect(params.required).to.include("prompt");
		expect(params.properties).to.have.property("model");
		expect(params.properties).to.have.property("tier");
		expect(params.properties).to.have.property("mode");
		expect(params.properties).to.have.property("dir");
		expect(params.properties).to.have.property("digest");
		expect(params.properties).to.have.property("timeout_ms");
		expect(registeredTool.promptGuidelines).to.be.an("array").that.is.not.empty;
		const guidance = registeredTool.promptGuidelines.join(" ");
		expect(guidance).to.include("Gemini quota group");
		expect(guidance).to.include("Claude quota group");
		expect(guidance).to.include("gpt-oss");
		expect(guidance).to.include("cross-review");
	});

	describe("execute pipeline", () => {
		let mockCtx: any;
		let execute: any;
		let origSpawn: any;

		beforeEach(() => {
			const mockPi: any = {
				registerTool(def: any) {
					registeredTool = def;
				},
			};
			piAgyExtension(mockPi);
			execute = registeredTool.execute;
			mockCtx = { cwd: path.resolve(__dirname, "../../..") };
			const cp = _require("node:child_process");
			origSpawn = cp.spawn;
		});

		afterEach(() => {
			const cp = _require("node:child_process");
			cp.spawn = origSpawn;
		});

		it("defaults compact digests off for writes and on for non-write modes", async () => {
			const cp = _require("node:child_process");
			const prompts: string[] = [];
			cp.spawn = function (_cmd: string, args: string[]) {
				const { EventEmitter } = _require("events");
				const child = new EventEmitter() as any;
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				process.nextTick(() => {
					if (!args.includes("--version") && !args.includes("models")) {
						prompts.push(args.at(-1)!);
						child.stdout.emit("data", Buffer.from("done"));
					}
					child.emit("close", 0, null);
				});
				return child;
			} as any;

			const run = (params: Record<string, unknown>) => execute(
				"test-id",
				params,
				undefined,
				undefined,
				mockCtx,
			);
			expect((await run({ prompt: "write" })).content[0].text).to.equal("done");
			expect((await run({ prompt: "review", mode: "plan" })).content[0].text).to.equal("done");
			expect(prompts).to.deep.equal([
				"write",
				"(Use compact digests, not full file contents.)\nreview",
			]);
		});

		it("passes Claude and Gemini model aliases to agy", async () => {
			const cp = _require("node:child_process");
			const models: string[] = [];
			cp.spawn = function (_cmd: string, args: string[]) {
				const { EventEmitter } = _require("events");
				const child = new EventEmitter() as any;
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				process.nextTick(() => {
					if (!args.includes("--version") && !args.includes("models")) {
						models.push(args[args.indexOf("--model") + 1]);
						child.stdout.emit("data", Buffer.from("done"));
					}
					child.emit("close", 0, null);
				});
				return child;
			} as any;

			for (const model of ["sonnet", "pro-low"]) {
				await execute("test-id", { prompt: "work", model }, undefined, undefined, mockCtx);
			}
			expect(models).to.deep.equal([
				"Claude Sonnet 4.6 (Thinking)",
				"Gemini 3.1 Pro (Low)",
			]);
		});

		it("throws tool failures instead of returning successful content", async () => {
			try {
				await execute(
					"test-id",
					{ prompt: "ping", dir: "missing-agy-test-directory" },
					undefined,
					undefined,
					mockCtx,
				);
				expect.fail("should have thrown");
			} catch (err) {
				expect((err as Error).message).to.include("agy failed:");
				expect((err as Error).message).to.include("ENOENT");
			}
		});

		it("truncates output over 8000 chars using mocked spawn", async () => {
			const cp = _require("node:child_process");
			const longString = "A".repeat(10000);

			cp.spawn = function (_cmd: string, _args: string[], _opts: any) {
				const { EventEmitter } = _require("events");
				const child = new EventEmitter() as any;
				child.stdout = new EventEmitter();
				child.stderr = new EventEmitter();
				child.pid = 999;

				process.nextTick(() => {
					if (_args?.includes("--version") || _args?.includes("models")) {
						child.emit("close", 0, null);
					} else {
						child.stdout.emit("data", Buffer.from(longString));
						child.emit("close", 0, null);
					}
				});
				return child;
			} as any;

			const result = await execute(
				"test-id",
				{ prompt: "generate long text", mode: "plan", digest: false },
				undefined,
				undefined,
				mockCtx,
			);

			const text = result.content[0].text;
			expect(text.length).to.be.lessThan(8500);
			expect(result.content[0].text).to.include("(Output truncated");
		});
	});
});
