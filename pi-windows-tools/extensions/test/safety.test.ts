import { describe, it } from "mocha";
import { expect } from "chai";
import { classifyCommand, isSensitivePath } from "../lib/safety";

describe("safety", () => {

	describe("classifyCommand", () => {
		it("returns safe for echo", () => {
			const r = classifyCommand("echo hello");
			expect(r.risk).to.equal("safe");
		});

		it("returns confirm for rm -rf", () => {
			const r = classifyCommand("rm -rf /some/dir");
			expect(r.risk).to.equal("confirm");
			expect(r.reasons.length).to.be.greaterThan(0);
		});

		it("returns confirm for Remove-Item -Recurse -Force", () => {
			const r = classifyCommand("Remove-Item -Recurse -Force C:\\temp");
			expect(r.risk).to.equal("confirm");
		});

		it("returns confirm for git push --force", () => {
			const r = classifyCommand("git push --force origin main");
			expect(r.risk).to.equal("confirm");
		});

		it("returns confirm for git clean -fdx", () => {
			const r = classifyCommand("git clean -fdx");
			expect(r.risk).to.equal("confirm");
		});

		it("returns confirm for npm publish", () => {
			const r = classifyCommand("npm publish");
			expect(r.risk).to.equal("confirm");
		});

		it("returns confirm for diskpart", () => {
			const r = classifyCommand("diskpart");
			expect(r.risk).to.equal("confirm");
		});

		it("returns confirm for format command", () => {
			const r = classifyCommand("format D: /fs:ntfs");
			expect(r.risk).to.equal("confirm");
		});

		it("returns confirm for takeown", () => {
			const r = classifyCommand("takeown /f C:\\somefile");
			expect(r.risk).to.equal("confirm");
		});

		it("detects sensitive file paths in command", () => {
			const r = classifyCommand("cat .env");
			expect(r.risk).to.equal("confirm");
			expect(r.reasons.some(r => r.includes("Environment"))).to.be.true;
		});

		it("detects SSH key paths", () => {
			const r = classifyCommand("cat ~/.ssh/id_rsa");
			expect(r.risk).to.equal("confirm");
		});

		it("returns safe for dir listing", () => {
			const r = classifyCommand("Get-ChildItem -Recurse -Filter *.ts");
			expect(r.risk).to.equal("safe");
		});

		it("returns safe for git status", () => {
			const r = classifyCommand("git status");
			expect(r.risk).to.equal("safe");
		});
	});

	describe("isSensitivePath", () => {
		it("detects .env", () => {
			expect(isSensitivePath("C:\\project\\.env")).to.be.true;
		});
		it("detects .env.local", () => {
			expect(isSensitivePath("C:\\project\\.env.local")).to.be.true;
		});
		it("detects .pem files", () => {
			expect(isSensitivePath("C:\\keys\\cert.pem")).to.be.true;
		});
		it("detects .ssh dir", () => {
			expect(isSensitivePath("C:\\Users\\me\\.ssh\\config")).to.be.true;
		});
		it("detects .aws dir", () => {
			expect(isSensitivePath("/home/me/.aws/credentials")).to.be.true;
		});
		it("allows normal files", () => {
			expect(isSensitivePath("C:\\project\\src\\index.ts")).to.be.false;
		});
	});
});
