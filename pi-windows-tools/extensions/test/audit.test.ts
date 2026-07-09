import { describe, it } from "mocha";
import { expect } from "chai";
import { record, entries, clear, format } from "../lib/audit";

describe("audit", () => {
  beforeEach(() => clear());

  it("starts empty", () => {
    expect(format()).to.equal("No commands executed yet.");
  });

  it("records an entry", () => {
    record({ timestamp: "a", shell: "pwsh", command: "echo hi", cwd: "/", exitCode: 0, timedOut: false, cancelled: false });
    expect(entries()).to.have.length(1);
    expect(entries()[0].command).to.equal("echo hi");
  });

  it("clear removes all entries", () => {
    record({ timestamp: "a", shell: "pwsh", command: "c1", cwd: "/", exitCode: 0, timedOut: false, cancelled: false });
    clear();
    expect(entries()).to.have.length(0);
  });

  it("format shows command and exit code", () => {
    record({ timestamp: "t", shell: "pwsh", command: "echo hi", cwd: "/", exitCode: 0, timedOut: false, cancelled: false });
    const out = format();
    expect(out).to.include("echo hi");
    expect(out).to.include("exit:0");
  });

  it("format shows timed out flag", () => {
    record({ timestamp: "a", shell: "cmd", command: "sleep 10", cwd: "/", exitCode: null, timedOut: true, cancelled: false });
    const out = format();
    expect(out).to.include("TIMED OUT");
  });

  it("format shows cancelled flag", () => {
    record({ timestamp: "a", shell: "cmd", command: "x", cwd: "/", exitCode: null, timedOut: false, cancelled: true });
    const out = format();
    expect(out).to.include("CANCELLED");
  });

  it("truncates long commands", () => {
    record({ timestamp: "a", shell: "pwsh", command: "x".repeat(500), cwd: "/", exitCode: 0, timedOut: false, cancelled: false });
    expect(format()).to.include("\u2026");
  });
});
