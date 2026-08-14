import { assert } from "chai";

import {
  PROTOCOL_VERSION,
  PI_SESSION_EXTENSION_URI,
  buildAgentCard,
  buildTask,
  extractText,
  jsonrpcError,
  jsonrpcResult,
  normalizeRole,
  normalizeState,
  sendMessageResponse,
  STATE_CANCELED,
  STATE_COMPLETED,
  STATE_FAILED,
  STATE_INPUT_REQUIRED,
  STATE_SUBMITTED,
  STATE_WORKING,
  TERMINAL_STATES,
  textMessage,
  textPart,
  filePart,
  dataPart,
  unwrapSendMessageResponse,
  ROLE_AGENT,
  ROLE_USER,
} from "../lib/protocol";

describe("protocol", () => {
  describe("constants & states", () => {
    it("pins protocol version to 1.0", () => {
      assert.equal(PROTOCOL_VERSION, "1.0");
    });

    it("marks the terminal states correctly", () => {
      assert.isTrue(TERMINAL_STATES.has(STATE_COMPLETED));
      assert.isTrue(TERMINAL_STATES.has(STATE_FAILED));
      assert.isTrue(TERMINAL_STATES.has(STATE_CANCELED));
      assert.isFalse(TERMINAL_STATES.has(STATE_WORKING));
      assert.isFalse(TERMINAL_STATES.has(STATE_SUBMITTED));
    });

    it("normalizes v0.3 lowercase states to v1.0", () => {
      assert.equal(normalizeState("completed"), STATE_COMPLETED);
      assert.equal(normalizeState("working"), STATE_WORKING);
      assert.equal(normalizeState("input_required"), STATE_INPUT_REQUIRED);
      assert.equal(normalizeState("TASK_STATE_FAILED"), STATE_FAILED);
      assert.equal(normalizeState(undefined), "");
    });

    it("normalizes v0.3 roles to v1.0", () => {
      assert.equal(normalizeRole("user"), ROLE_USER);
      assert.equal(normalizeRole("agent"), ROLE_AGENT);
      assert.equal(normalizeRole("assistant"), ROLE_AGENT);
      assert.equal(normalizeRole("ROLE_USER"), ROLE_USER);
    });
  });

  describe("Agent Card", () => {
    it("builds a v1.0 card with a JSONRPC interface", () => {
      const card = buildAgentCard({
        name: "pi",
        url: "http://localhost:9910/",
      });
      assert.equal(card.name, "pi");
      assert.equal(card.version, "1.0.0");
      assert.equal(card.supportedInterfaces[0]?.protocolBinding, "JSONRPC");
      assert.equal(card.supportedInterfaces[0]?.protocolVersion, PROTOCOL_VERSION);
      assert.equal(card.supportedInterfaces[0]?.url, "http://localhost:9910/");
      assert.isFalse(card.capabilities.streaming);
      assert.isUndefined(card.securitySchemes);
      assert.equal(card.defaultInputModes[0], "text/plain");
    });

    it("advertises bearer auth when required", () => {
      const card = buildAgentCard({ name: "pi", url: "http://x/", authRequired: true });
      assert.deepEqual(card.securitySchemes, { bearer: { type: "http", scheme: "bearer" } });
      assert.deepEqual(card.security, [{ bearer: [] }]);
    });

    it("uses configured skills and caps", () => {
      const card = buildAgentCard({
        name: "pi",
        url: "http://x/",
        streaming: true,
        pushNotifications: true,
        skills: [{ id: "s1", name: "coding", description: "d" }],
      });
      assert.isTrue(card.capabilities.streaming);
      assert.isTrue(card.capabilities.pushNotifications);
      assert.equal(card.skills[0]?.id, "s1");
    });

    it("omits extensions/metadata when no sessionMetadata provided", () => {
      const card = buildAgentCard({ name: "pi", url: "http://x/" });
      assert.isUndefined(card.capabilities.extensions);
      assert.isUndefined(card.metadata);
    });

    it("emits the pi-session extension + metadata when sessionMetadata provided", () => {
      const card = buildAgentCard({
        name: "pi",
        url: "http://localhost:9910/",
        sessionMetadata: {
          pid: 12345,
          cwd: "/repo",
          model: { provider: "anthropic", id: "claude" },
          tools: ["bash", "read"],
          startedAt: "2026-01-01T00:00:00Z",
        },
      });
      assert.isDefined(card.capabilities.extensions);
      assert.lengthOf(card.capabilities.extensions!, 1);
      assert.equal(card.capabilities.extensions![0]!.uri, PI_SESSION_EXTENSION_URI);
      assert.isFalse(card.capabilities.extensions![0]!.required);
      assert.deepEqual(card.metadata, {
        pid: 12345,
        cwd: "/repo",
        model: { provider: "anthropic", id: "claude" },
        tools: ["bash", "read"],
        startedAt: "2026-01-01T00:00:00Z",
      });
    });
  });

  describe("JSON-RPC framing", () => {
    it("wraps results and errors", () => {
      assert.deepEqual(jsonrpcResult(1, { ok: true }), { jsonrpc: "2.0", id: 1, result: { ok: true } });
      assert.deepEqual(jsonrpcError(2, -32001, "nope"), {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32001, message: "nope" },
      });
    });

    it("wraps a Task payload as {task}, a Message as {message}", () => {
      const task = buildTask({ id: "t1", contextId: "c1" });
      assert.deepEqual(sendMessageResponse(task), { task });
      const msg = textMessage(ROLE_AGENT, "hi");
      assert.deepEqual(sendMessageResponse(msg), { message: msg });
    });

    it("unwraps v1.0 {task}/{message} and passes legacy through", () => {
      const task = { id: "t1", status: { state: STATE_COMPLETED } };
      assert.deepEqual(unwrapSendMessageResponse({ task }), task);
      assert.deepEqual(unwrapSendMessageResponse({ message: { x: 1 } }), { x: 1 });
      // legacy bare payload passes through
      assert.deepEqual(unwrapSendMessageResponse(task), task);
    });
  });

  describe("Parts — extractText (v1.0 + v0.3 tolerant)", () => {
    it("extracts v1.0 text parts", () => {
      const msg = { parts: [textPart("hello"), textPart("world")] };
      assert.equal(extractText(msg), "hello\nworld");
    });

    it("renders v1.0 file parts with url", () => {
      const msg = { parts: [filePart({ url: "http://x/f.txt", filename: "f.txt", mediaType: "text/plain" })] };
      assert.equal(extractText(msg), "[file: f.txt] http://x/f.txt (text/plain)");
    });

    it("notes raw base64 file parts without decoding", () => {
      const msg = { parts: [filePart({ raw: "AAAABBBBB", filename: "bin", mediaType: "image/png" })] };
      assert.equal(extractText(msg), "[file: bin] 9 bytes base64-encoded (image/png)");
    });

    it("renders v1.0 data parts as JSON", () => {
      const msg = { parts: [dataPart({ a: 1 })] };
      assert.equal(extractText(msg), JSON.stringify({ a: 1 }));
    });

    it("accepts v0.3 kind:text parts", () => {
      const msg = { parts: [{ kind: "text", text: "legacy" }] };
      assert.equal(extractText(msg), "legacy");
    });

    it("accepts v0.3 file with nested fileWithUri", () => {
      const msg = {
        parts: [{ file: { fileWithUri: "http://x/a.png", name: "a.png", mimeType: "image/png" } }],
      };
      assert.equal(extractText(msg), "[file: a.png] http://x/a.png (image/png)");
    });

    it("pulls text from a Task result (artifacts first, then status.message)", () => {
      const taskWithArtifact = {
        artifacts: [{ parts: [textPart("artifact reply")] }],
      };
      assert.equal(extractText(taskWithArtifact), "artifact reply");

      const taskWithStatusMsg = {
        status: { message: { parts: [textPart("status reply")] } },
      };
      assert.equal(extractText(taskWithStatusMsg), "status reply");
    });
  });

  describe("Task construction", () => {
    it("builds a submitted task by default", () => {
      const t = buildTask({ id: "t1", contextId: "c1" });
      assert.equal(t.id, "t1");
      assert.equal(t.contextId, "c1");
      assert.equal(t.status.state, STATE_SUBMITTED);
      assert.isString(t.status.timestamp);
    });

    it("accepts an explicit state", () => {
      const t = buildTask({ id: "t1", contextId: "c1", state: STATE_INPUT_REQUIRED });
      assert.equal(t.status.state, STATE_INPUT_REQUIRED);
    });
  });
});
