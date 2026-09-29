import { describe, it } from "mocha";
import { assert } from "chai";
import { stripInputRequired, terminalOutcomeError } from "../lib/outcome.js";

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

describe("stripInputRequired (tail-anchored marker)", () => {
  it("a marker at the trimmed tail flips the state and is stripped once", () => {
    const r = stripInputRequired("need more info [INPUT_REQUIRED]");
    assert.equal(r.text, "need more info");
    assert.isTrue(r.inputRequired);
  });
  it("trailing whitespace after the marker still counts", () => {
    const r = stripInputRequired("ok [INPUT_REQUIRED]  \n");
    assert.equal(r.text, "ok");
    assert.isTrue(r.inputRequired);
  });
  it("a quoted marker mid-text neither flips the state nor mangles the text", () => {
    const r = stripInputRequired("earlier log said [INPUT_REQUIRED] but we moved on");
    assert.equal(r.text, "earlier log said [INPUT_REQUIRED] but we moved on");
    assert.isFalse(r.inputRequired);
  });
  it("a marker as message prefix is content, not a signal", () => {
    const r = stripInputRequired("[INPUT_REQUIRED] is the marker syntax");
    assert.isFalse(r.inputRequired);
    assert.equal(r.text, "[INPUT_REQUIRED] is the marker syntax");
  });
  it("a bare marker strips to empty text", () => {
    const r = stripInputRequired("[INPUT_REQUIRED]");
    assert.equal(r.text, "");
    assert.isTrue(r.inputRequired);
  });
  it("matching is case-insensitive", () => {
    const r = stripInputRequired("hi [input_required]");
    assert.isTrue(r.inputRequired);
    assert.equal(r.text, "hi");
  });
});
