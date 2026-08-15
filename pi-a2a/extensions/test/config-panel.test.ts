import { assert } from "chai";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULTS } from "./helpers";
import { applyRows, buildRows, ConfigPanelModel, kindValue } from "../lib/config-panel";

describe("config-panel", () => {
  it("buildRows covers server, discovery, gateway, identity, peers, ui groups", () => {
    const cfg = DEFAULTS();
    cfg.peers = { hermes: { url: "http://localhost:9900", auth: { type: "none" }, timeout: 120000, capabilities: [] } };
    const groups = buildRows(cfg);
    const keys = groups.map((g) => g.key);
    assert.deepEqual(keys, ["server", "discovery", "gateway", "identity", "peers", "ui"]);
    const serverRows = groups[0]!.rows.map((r) => r.key);
    assert.include(serverRows, "server.enabled");
    assert.include(serverRows, "server.port");
    const gatewayRows = groups[2]!.rows.map((r) => r.key);
    assert.deepEqual(gatewayRows, [
      "gateway.enabled",
      "gateway.url",
      "gateway.token",
      "gateway.name",
      "gateway.upstreamToken",
      "gateway.heartbeatSec",
      "gateway.channel",
    ]);
    const peerRows = groups[4]!.rows.map((r) => r.key);
    assert.deepEqual(peerRows, ["peer.hermes.url"]);
  });

  it("toggle row set flips the underlying config value", () => {
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    const row = groups[0]!.rows.find((r) => r.key === "server.enabled")!;
    assert.equal(row.value, false);
    row.set(true);
    assert.equal(cfg.server.enabled, true);
  });

  it("row.set also updates row.value (toggles render the new state)", () => {
    // Regression: before the fix, row.value stayed stale so toggling looked dead.
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    const row = groups[0]!.rows.find((r) => r.key === "server.enabled")!;
    assert.equal(row.value, false);
    row.set(true);
    assert.equal(row.value, true, "row.value must track the backing config");
    row.set(false);
    assert.equal(row.value, false);
    assert.equal(cfg.server.enabled, false);
  });

  it("number row set coerces strings and rejects garbage", () => {
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    const row = groups[0]!.rows.find((r) => r.key === "server.port")!;
    row.set("9933");
    assert.equal(cfg.server.port, 9933);
    row.set("not-a-number");
    assert.equal(cfg.server.port, 9933); // keeps prior value
  });

  it("string row set updates the config", () => {
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    // Gateway group added between discovery and identity (0.5.0):
    // server(10) + discovery(6) + gateway(7) = index 23.
    const row = groups[3]!.rows.find((r) => r.key === "selfIdentity")!;
    row.set("session-a");
    assert.equal(cfg.selfIdentity, "session-a");
  });

  it("applyRows applies every row onto the config the rows were built from", () => {
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    // Mutate some row values.
    groups[0]!.rows.find((r) => r.key === "server.enabled")!.value = true;
    groups[0]!.rows.find((r) => r.key === "server.port")!.value = 9944;
    groups[3]!.rows.find((r) => r.key === "selfIdentity")!.value = "session-b";
    applyRows(cfg, groups);
    assert.equal(cfg.server.enabled, true);
    assert.equal(cfg.server.port, 9944);
    assert.equal(cfg.selfIdentity, "session-b");
  });

  it("gateway rows materialize discovery.gateway on edit (enabled toggle)", () => {
    const cfg = DEFAULTS();
    assert.isUndefined(cfg.discovery.gateway);
    const groups = buildRows(cfg);
    const row = groups[2]!.rows.find((r) => r.key === "gateway.enabled")!;
    assert.equal(row.value, false, "default view: disabled");
    row.set(true);
    assert.isDefined(cfg.discovery.gateway, "setter materializes the block");
    assert.equal((cfg.discovery.gateway as { enabled: boolean }).enabled, true);
  });

  it("masked rows render no raw secret (display only)", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateway = { enabled: true, url: "http://g", token: "supersecret" };
    const model = new ConfigPanelModel(buildRows(cfg), null);
    // Navigate to gateway.token (server 10 + discovery 6 + gateway 2 = index 18).
    for (let i = 0; i < 18; i++) model.handleInput("\u001b[B");
    const out = model.render(80).join("\n");
    assert.ok(!out.includes("supersecret"), "raw token must not appear");
    assert.match(out, /••••/);
    // row.value still carries the real secret for persistence
    const tokenRow = buildRows(cfg)[2]!.rows.find((r) => r.key === "gateway.token")!;
    assert.equal(tokenRow.value, "supersecret");
  });

  it("empty submit on a masked row keeps the existing secret (no wipe)", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateway = { enabled: true, url: "http://g", token: "supersecret" };
    const model = new ConfigPanelModel(buildRows(cfg), null);
    model.onChanged = () => { model.dirty = true; };
    // Navigate to gateway.token (server 10 + discovery 6 + gateway 2 = index 18).
    for (let i = 0; i < 18; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // start edit
    model.handleInput("\r"); // submit EMPTY → must keep the secret
    assert.equal(cfg.discovery.gateway!.token, "supersecret", "empty submit keeps the token");
    assert.isFalse(model.dirty, "no change recorded");
  });

  it("action rows run the provided action", async () => {
    const cfg = DEFAULTS();
    let ran = 0;
    const groups = buildRows(cfg, {
      addPeer: { label: "Add peer", run: () => { ran++; } },
    });
    const actionRow = groups[4]!.rows.find((r) => r.key === "action.addPeer")!;
    assert.equal(actionRow.kind, "action");
    await actionRow.set(undefined);
    assert.equal(ran, 1);
  });

  it("prompt flow: action receives the typed value via inline prompt", () => {
    const cfg = DEFAULTS();
    const model = new ConfigPanelModel(buildRows(cfg, {
      addPeer: {
        label: "Add peer",
        run: (prompt) => {
          prompt("Peer name", (name) => {
            if (name) {
              cfg.peers[name] = { url: "http://x", auth: { type: "none" }, timeout: 1, capabilities: [] };
              model.dirty = true;
            }
          });
        },
      },
    }), null);
    // Wire onAction exactly like openConfigPanel does.
    model.onAction = async (row) => {
      await row.set((label: string, onDone: (v: string | undefined) => void) => {
        model.prompt(label, onDone);
      });
      model.requestRender();
    };
    // Navigate to the add-peer action row: server(10) + discovery(6) + gateway(7) + identity(1) + peers(0) = index 24.
    for (let i = 0; i < 24; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // activate → prompt opens
    for (const ch of "newpeer") model.handleInput(ch);
    model.handleInput("\r"); // confirm
    assert.equal(cfg.peers.newpeer?.url, "http://x");
    assert.isTrue(model.dirty);
  });

  it("Esc during prompt cancels (no value)", () => {
    const cfg = DEFAULTS();
    const model = new ConfigPanelModel(buildRows(cfg, {
      addPeer: {
        label: "Add peer",
        run: (prompt) => { prompt("Peer name", (name) => { if (name) cfg.peers[name] = { url: "x", auth: { type: "none" }, timeout: 1, capabilities: [] }; }); },
      },
    }), null);
    model.onAction = async (row) => {
      await row.set((label: string, onDone: (v: string | undefined) => void) => {
        model.prompt(label, onDone);
      });
      model.requestRender();
    };
    for (let i = 0; i < 24; i++) model.handleInput("\u001b[B");
    model.handleInput("\r");
    for (const ch of "cancelled") model.handleInput(ch);
    model.handleInput("\u001b"); // cancel
    assert.isUndefined(cfg.peers.cancelled);
  });

  describe("ConfigPanelModel (keyboard fallback)", () => {
    it("navigates with arrow keys and toggles on Enter", () => {
      const cfg = DEFAULTS();
      const model = new ConfigPanelModel(buildRows(cfg), null);
      let renders = 0;
      model.onRequestRender = () => { renders++; };
      // First row is server.enabled (toggle, off).
      model.handleInput("\u001b[B"); // down
      model.handleInput("\u001b[A"); // up → back to row 0
      model.handleInput("\r"); // enter → toggle
      assert.equal(cfg.server.enabled, true);
      assert.isTrue(model.dirty);
      assert.isAtLeast(renders, 3);
    });

    it("edits a string row via the inline input", () => {
      const cfg = DEFAULTS();
      const model = new ConfigPanelModel(buildRows(cfg), null);
      model.onChanged = () => { model.dirty = true; };
      // Navigate to identity.selfIdentity (index: server 10 + discovery 6 + gateway 7 = 23).
      for (let i = 0; i < 23; i++) model.handleInput("\u001b[B");
      model.handleInput("\r"); // start inline edit
      // The panel now routes keys to the embedded Input: type + submit.
      for (const ch of "session-b") model.handleInput(ch);
      model.handleInput("\r"); // submit
      assert.equal(cfg.selfIdentity, "session-b");
      assert.isTrue(model.dirty);
    });

    it("Esc during inline edit cancels without changing the value", () => {
      const cfg = DEFAULTS();
      const model = new ConfigPanelModel(buildRows(cfg), null);
      for (let i = 0; i < 23; i++) model.handleInput("\u001b[B");
      model.handleInput("\r"); // start edit
      for (const ch of "changed") model.handleInput(ch);
      model.handleInput("\u001b"); // cancel edit
      assert.equal(cfg.selfIdentity, ""); // unchanged
      assert.isFalse(model.dirty);
    });

    it("edits a number row with coercion", () => {
      const cfg = DEFAULTS();
      const model = new ConfigPanelModel(buildRows(cfg), null);
      model.handleInput("\u001b[B"); // server.port (row 1)
      model.handleInput("\r");
      for (const ch of "9933") model.handleInput(ch);
      model.handleInput("\r");
      assert.equal(cfg.server.port, 9933);
    });

    it("Esc invokes onClose", () => {
      const cfg = DEFAULTS();
      const model = new ConfigPanelModel(buildRows(cfg), null);
      let closed = 0;
      model.onClose = () => { closed++; };
      model.handleInput("\u001b");
      assert.equal(closed, 1);
    });
  });

  describe("render width safety", () => {
    it("never exceeds the given width, even with a long peer URL", () => {
      const cfg = DEFAULTS();
      cfg.peers = {
        "very-long-peer-name": {
          url: "http://a-really-long-host.example.com:9999/some/deep/path?with=query&and=more",
          auth: { type: "none" },
          timeout: 120000,
          capabilities: [],
        },
      };
      const model = new ConfigPanelModel(buildRows(cfg), null);
      // Scroll to the peers row (long URL) and render at a small width.
      for (let i = 0; i < 40; i++) model.handleInput("\u001b[B");
      const width = 60;
      for (const line of model.render(width)) {
        assert.ok(visibleWidth(line) <= width, "line too wide: " + line);
      }
    });

    it("truncates during inline edit (long value + hint)", () => {
      const cfg = DEFAULTS();
      cfg.peers = {
        p: {
          url: "http://a-really-long-host.example.com:9999/some/deep/path?with=query&and=more",
          auth: { type: "none" },
          timeout: 120000,
          capabilities: [],
        },
      };
      const model = new ConfigPanelModel(buildRows(cfg), null);
      // Navigate to the peer URL row (server 10 + discovery 6 + gateway 7 + identity 1 = 24).
      for (let i = 0; i < 24; i++) model.handleInput("\u001b[B");
      model.handleInput("\r"); // start edit
      const width = 60;
      for (const line of model.render(width)) {
        assert.ok(visibleWidth(line) <= width, "edit line too wide: " + line);
      }
    });
  });

  describe("group-coherent windowing (0.5.1)", () => {
    it("renders whole groups — a header never appears without its full rows", () => {
      const cfg = DEFAULTS();
      cfg.peers = { hermes: { url: "http://localhost:9900", auth: { type: "none" }, timeout: 120000, capabilities: [] } };
      const model = new ConfigPanelModel(buildRows(cfg), null);
      const headerRe = /^[A-Z][A-Z ]*$/;
      // Render every scroll position; at each one, every group header that
      // appears must be followed by ALL of its rows before the next header
      // or the footer — i.e. no split group with a detached header.
      const expected: Record<string, number> = {
        SERVER: 10, DISCOVERY: 6, GATEWAY: 7, IDENTITY: 1, PEERS: 1, UI: 1,
      };
      const steps = 8; // render + scroll several times to hit every window
      for (let step = 0; step < steps; step++) {
        const lines = model.render(80);
        const body = lines.slice(3, lines.indexOf("… ") === -1 ? lines.length - 3 : lines.indexOf("… "));
        let i = 0;
        while (i < body.length) {
          const line = body[i]!;
          if (headerRe.test(line.trim()) && expected[line.trim()] !== undefined) {
            const name = line.trim();
            const count = expected[name]!;
            // The next `count` lines must be the group's rows (no header in between).
            for (let j = 1; j <= count; j++) {
              const row = body[i + j];
              assert.isDefined(row, `group ${name} row ${j} missing at step ${step}`);
              assert.ok(
                !headerRe.test(row.trim()) || expected[row.trim()] === undefined,
                `group ${name} split: header '${row}' inside its rows at step ${step}`,
              );
            }
          }
          i++;
        }
        // Scroll down one group's worth and re-render.
        for (let k = 0; k < 3; k++) model.handleInput("\u001b[B");
      }
    });

    it("initial view shows SERVER + DISCOVERY together (no split)", () => {
      const cfg = DEFAULTS();
      const model = new ConfigPanelModel(buildRows(cfg), null);
      const out = model.render(80).join("\n");
      assert.ok(out.includes("SERVER"), "SERVER header present");
      assert.ok(out.includes("DISCOVERY"), "DISCOVERY header present on first screen");
      // Every discovery row is on screen (group not truncated mid-way).
      for (const label of ["Local registry", "Heartbeat (s)", "Registry TTL (s)", "mDNS broadcast", "mDNS service type", "Enrich Agent Card"]) {
        assert.ok(out.includes(label), `DISCOVERY row '${label}' visible on first screen`);
      }
    });
  });

  describe("kindValue", () => {
    it("parses numbers", () => {
      assert.equal(kindValue("number", "123"), 123);
      assert.equal(kindValue("number", "abc"), "abc");
    });
    it("parses toggles", () => {
      assert.equal(kindValue("toggle", "true"), true);
      assert.equal(kindValue("toggle", "off"), false);
    });
    it("passes strings through", () => {
      assert.equal(kindValue("string", "hello"), "hello");
    });
  });
});
