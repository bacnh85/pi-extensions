import { assert } from "chai";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULTS } from "./helpers";
import { applyRows, buildRows, ConfigPanelModel, kindValue, makeOnAction, type PanelAction } from "../lib/config-panel";

describe("config-panel", () => {
  it("buildRows covers server, discovery, gateway, gateways, identity, peers, ui groups", () => {
    const cfg = DEFAULTS();
    cfg.peers = { hermes: { url: "http://localhost:9900", auth: { type: "none" }, timeout: 120000, capabilities: [] } };
    const groups = buildRows(cfg);
    const keys = groups.map((g) => g.key);
    assert.deepEqual(keys, ["server", "discovery", "gateway", "gateways", "identity", "peers", "ui"]);
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
    const peerRows = groups[5]!.rows.map((r) => r.key);
    assert.deepEqual(peerRows, ["peer.hermes.url"]);
  });

  it("gateways group renders per-entry rows + add/remove actions", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateways = {
      work: { enabled: true, url: "http://10.0.0.5:9920", token: "t1" },
    };
    const groups = buildRows(cfg, {
      addGateway: { label: "+ Add gateway", run: () => {} },
      removeGateway: { label: "− Remove gateway", run: () => {} },
    });
    const gwRows = groups[3]!.rows.map((r) => r.key);
    assert.deepEqual(gwRows, [
      "gw.work.enabled",
      "gw.work.url",
      "gw.work.token",
      "gw.work.name",
      "gw.work.upstreamToken",
      "gw.work.heartbeatSec",
      "gw.work.channel",
      "action.addGateway",
      "action.removeGateway",
    ]);
    // Setters materialize on edit.
    const row = groups[3]!.rows.find((r) => r.key === "gw.work.url")!;
    row.set("http://new");
    assert.equal(cfg.discovery.gateways!.work.url, "http://new");
  });

  it("gateways rows are masked for token fields", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateways = { lab: { enabled: true, url: "http://g", token: "labsecret" } };
    const rows = buildRows(cfg)[3]!.rows;
    const tokenRow = rows.find((r) => r.key === "gw.lab.token")!;
    assert.equal(tokenRow.value, "labsecret");
    assert.isTrue(tokenRow.mask, "gateway token row must be masked");
    const upRow = rows.find((r) => r.key === "gw.lab.upstreamToken")!;
    assert.isTrue(upRow.mask, "upstream token row must be masked");
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
    // Gateways group added between gateway and identity (0.6.0):
    // server(10) + discovery(6) + gateway(7) + gateways(0) = index 23.
    const row = groups[4]!.rows.find((r) => r.key === "selfIdentity")!;
    row.set("session-a");
    assert.equal(cfg.selfIdentity, "session-a");
  });

  it("applyRows applies every row onto the config the rows were built from", () => {
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    // Mutate some row values.
    groups[0]!.rows.find((r) => r.key === "server.enabled")!.value = true;
    groups[0]!.rows.find((r) => r.key === "server.port")!.value = 9944;
    groups[4]!.rows.find((r) => r.key === "selfIdentity")!.value = "session-b";
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
    const actionRow = groups[5]!.rows.find((r) => r.key === "action.addPeer")!;
    assert.equal(actionRow.kind, "action");
    await actionRow.set(undefined);
    assert.equal(ran, 1);
  });

  it("add-gateway action rebuilds rows through the production onAction wiring", async () => {
    const cfg = DEFAULTS();
    const actions: Record<string, PanelAction> = {
      addGateway: {
        label: "Add gateway",
        // Mirrors index.ts: resolves only after the LAST prompt's onDone so
        // the awaiting onAction rebuilds rows after the config is mutated.
        run: (prompt) => {
          return new Promise<void>((resolve) => {
            prompt("Gateway key", (key) => {
              if (!key) return resolve();
              prompt(`Gateway URL for '${key}'`, (url) => {
                if (!url) return resolve();
                prompt(`API token for '${key}'`, (token) => {
                  cfg.discovery.gateways ??= {};
                  cfg.discovery.gateways[key] = { enabled: true, url, token: token ?? "" };
                  resolve();
                });
              });
            });
          });
        },
      },
    };
    const model = new ConfigPanelModel(buildRows(cfg, actions), null);
    // Use the SAME handler factory openConfigPanel uses — deleting the
    // setGroups rebuild inside makeOnAction must fail this test.
    model.onAction = makeOnAction(model, cfg, actions, () => {});
    // No gateway rows yet.
    assert.ok(!model.groups[3].rows.some((r) => r.key.startsWith("gw.")), "no gateway rows before add");
    // Navigate to the add-gateway action row: server(10)+discovery(6)+gateway(7) = index 23.
    for (let i = 0; i < 23; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // activate → prompt opens
    for (const ch of "new1") model.handleInput(ch);
    model.handleInput("\r"); // confirm key
    for (const ch of "http://gw") model.handleInput(ch);
    model.handleInput("\r"); // confirm url
    for (const ch of "tok123") model.handleInput(ch);
    model.handleInput("\r"); // confirm token
    // The onAction continuation (setGroups rebuild) resolves on a microtask
    // after the synchronous keystroke stream — flush it before asserting.
    await new Promise((r) => setTimeout(r, 0));
    // Rows were rebuilt via onAction → the new entry is editable now.
    const gwKeys = model.groups[3].rows.map((r) => r.key);
    assert.ok(gwKeys.includes("gw.new1.url"), "new gateway rows appear after rebuild: " + gwKeys.join(","));
    assert.ok(gwKeys.includes("gw.new1.token"), "new gateway token row appears");
    assert.equal(cfg.discovery.gateways!.new1.token, "tok123");
    assert.isTrue(model.dirty, "action marks the panel dirty");
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
