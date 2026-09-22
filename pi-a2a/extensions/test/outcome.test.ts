import { describe, it } from "mocha";
import { assert } from "chai";
import { terminalOutcomeError } from "../lib/outcome.js";

describe("terminal outcome (#314, #425)", () => {
  it("a normal text ending is a success", () => {
    assert.isNull(terminalOutcomeError({ stopReason: "stop", hadText: true, sawAssistant: true }));
  });
  it("a tool-use ending with text is a success", () => {
    assert.isNull(terminalOutcomeError({ stopReason: "toolUse", hadText: true, sawAssistant: true }));
  });
  it("a provider error on the final turn fails, carrying the error", () => {
    const e = terminalOutcomeError({ stopReason: "error", hadText: false, sawAssistant: true, errorMessage: '503: {"message":"no available channel"}' });
    assert.match(e!, /model call failed on the final turn: 503/);
  });
  it("a provider error fails even when an earlier turn left text behind", () => {
    assert.isNotNull(terminalOutcomeError({ stopReason: "error", hadText: true, sawAssistant: true }));
  });
  it("no assistant output at all fails", () => {
    assert.match(terminalOutcomeError({ hadText: false, sawAssistant: false })!, /without any assistant output/);
  });
  it("a length stop with no text still fails (#314)", () => {
    assert.match(terminalOutcomeError({ stopReason: "length", hadText: false, sawAssistant: true })!, /length stop/);
  });
  it("a length stop that produced text is a success", () => {
    assert.isNull(terminalOutcomeError({ stopReason: "length", hadText: true, sawAssistant: true }));
  });
});
