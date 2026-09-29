/// Regression tests: /a2a-broadcast --agents parsing (nightly 2026-09-29).
/// The flag is only honored LEADING or TRAILING — an occurrence inside the
/// message body is content, not a flag (the old global-regex strip mangled
/// body text like "remember --agents x is the syntax").
import { describe, it } from "mocha";
import { assert } from "chai";
import { parseBroadcastArgs } from "../index.js";

describe("parseBroadcastArgs (--agents leading/trailing only)", () => {
  it("trailing flag is parsed and stripped", () => {
    assert.deepEqual(parseBroadcastArgs("do the thing --agents a,b"), { message: "do the thing", agents: ["a", "b"] });
  });
  it("leading flag is parsed and stripped", () => {
    assert.deepEqual(parseBroadcastArgs("--agents a,b do the thing"), { message: "do the thing", agents: ["a", "b"] });
  });
  it("a flag occurrence inside the body is content — no flip, no mangle", () => {
    assert.deepEqual(parseBroadcastArgs("remember --agents x is the syntax"), {
      message: "remember --agents x is the syntax",
      agents: [],
    });
  });
  it("no flag: whole input is the message, no agents", () => {
    assert.deepEqual(parseBroadcastArgs("hello world"), { message: "hello world", agents: [] });
  });
  it("single agent, no comma", () => {
    assert.deepEqual(parseBroadcastArgs("go --agents solo"), { message: "go", agents: ["solo"] });
  });
  it("input is trimmed", () => {
    assert.deepEqual(parseBroadcastArgs("  hi  "), { message: "hi", agents: [] });
  });
});
