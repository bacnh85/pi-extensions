import { assert } from "chai";
import { visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULTS } from "./helpers";
import { buildRows, ConfigPanelModel, kindValue, makeOnAction, type PanelAction } from "../lib/config-panel";

describe("config-panel", () => {
  it("buildRows covers server, discovery, gateway, gateways, identity, peers, ui groups", () => {
    const cfg = DEFAULTS();
    cfg.peers = { hermes: { url: "http://localhost:9900", auth: { type: "none" }, timeout: 120000, capabilities: [] } };
    // Legacy gateway block must be LIVE to render (0.7.6: inert placeholder hidden).
    cfg.discovery.gateway = { enabled: true, url: "http://legacy:9920", token: "t" };
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

  it("hides an inert legacy gateway block; labels carry settings-key hints", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateway = { enabled: false, url: "", token: "" };
    cfg.discovery.gateways = { remote: { enabled: true, url: "http://10.0.0.5:9920", token: "t" } };
    const groups = buildRows(cfg);
    const keys = groups.map((g) => g.key);
    assert.notInclude(keys, "gateway", "inert legacy block must not render");
    const allRowKeys = groups.flatMap((g) => g.rows.map((r) => r.key));
    assert.notInclude(allRowKeys.filter((k) => k.startsWith("gateway.")) as string[], "gateway.enabled");
    assert.include(allRowKeys, "gw.remote.enabled");
    const labels = groups.map((g) => g.label);
    assert.include(labels, "Gateways (discovery.gateways)");
    assert.notInclude(labels, "Gateway (discovery.gateway)", "legacy label only when live");
  });

  it("renders a live legacy gateway block with its key-hinted label", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateway = { enabled: false, url: "http://legacy:9920", token: "" };
    const groups = buildRows(cfg);
    const legacy = groups.find((g) => g.key === "gateway")!;
    assert.equal(legacy.label, "Gateway (discovery.gateway)");
    assert.include(legacy.rows.map((r) => r.key), "gateway.url");
  });

  it("non-default name/heartbeat/channel make an otherwise-empty block live", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateway = { enabled: false, url: "", token: "", name: "mygateway", heartbeatSec: 120, channel: false };
    const groups = buildRows(cfg);
    const legacy = groups.find((g) => g.key === "gateway");
    assert.isOk(legacy, "non-default fields carry real config — must render");
    const row = legacy!.rows.find((r) => r.key === "gateway.heartbeatSec")!;
    assert.equal(row.value, 120);
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
    const gwRows = groups.find((g) => g.key === "gateways")!.rows.map((r) => r.key);
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
    const row = groups.find((g) => g.key === "gateways")!.rows.find((r) => r.key === "gw.work.url")!;
    row.set("http://new");
    assert.equal(cfg.discovery.gateways!.work.url, "http://new");
  });

  it("gateways rows are masked for token fields", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateways = { lab: { enabled: true, url: "http://g", token: "labsecret" } };
    const rows = buildRows(cfg).find((g) => g.key === "gateways")!.rows;
    const tokenRow = rows.find((r) => r.key === "gw.lab.token")!;
    assert.equal(tokenRow.value, "labsecret");
    assert.isTrue(tokenRow.mask, "gateway token row must be masked");
    const upRow = rows.find((r) => r.key === "gw.lab.upstreamToken")!;
    assert.isTrue(upRow.mask, "upstream token row must be masked");
  });






  it("gateway rows edit a live legacy block in place (enabled toggle)", () => {
    const cfg = DEFAULTS();
    cfg.discovery.gateway = { enabled: false, url: "http://legacy:9920", token: "" };
    const groups = buildRows(cfg);
    const row = groups.find((g) => g.key === "gateway")!.rows.find((r) => r.key === "gateway.enabled")!;
    assert.equal(row.value, false);
    row.set(true);
    assert.equal((cfg.discovery.gateway as { enabled: boolean }).enabled, true, "edits land on the existing block");
  });

  it("legacy gateway group stays hidden when only env-vars could supply it", () => {
    // No block + no env → nothing renders; discovery edits must not create one.
    const cfg = DEFAULTS();
    assert.isUndefined(cfg.discovery.gateway);
    const groups = buildRows(cfg);
    assert.notInclude(groups.map((g) => g.key), "gateway");
  });



  it("action rows run the provided action", async () => {
    const cfg = DEFAULTS();
    let ran = 0;
    const groups = buildRows(cfg, {
      addPeer: { label: "Add peer", run: () => { ran++; } },
    });
    const actionRow = groups.find((g) => g.key === "peers")!.rows.find((r) => r.key === "action.addPeer")!;
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
    model.onAction = makeOnAction(model, cfg, buildRows, actions, () => {});
    // No gateway rows yet.
    const gatewaysGroup = () => model.groups.find((g) => g.key === "gateways")!;
    assert.ok(!gatewaysGroup().rows.some((r) => r.key.startsWith("gw.")), "no gateway rows before add");
    // Navigate to the add-gateway action row (last row of the gateways group).
    const addGwIndex = model.groups.slice(0, model.groups.indexOf(gatewaysGroup())).reduce((n, g) => n + g.rows.length, 0)
      + gatewaysGroup().rows.findIndex((r) => r.key === "action.addGateway");
    for (let i = 0; i < addGwIndex; i++) model.handleInput("\u001b[B");
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
    const gwKeys = gatewaysGroup().rows.map((r) => r.key);
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
    // Navigate to the add-peer action row (only row of the peers group here).
    const peersGroup = () => model.groups.find((g) => g.key === "peers")!;
    const addPeerIndex = model.groups.slice(0, model.groups.indexOf(peersGroup())).reduce((n, g) => n + g.rows.length, 0)
      + peersGroup().rows.findIndex((r) => r.key === "action.addPeer");
    for (let i = 0; i < addPeerIndex; i++) model.handleInput("\u001b[B");
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
    const peersGroup = () => model.groups.find((g) => g.key === "peers")!;
    const addPeerIndex = model.groups.slice(0, model.groups.indexOf(peersGroup())).reduce((n, g) => n + g.rows.length, 0)
      + peersGroup().rows.findIndex((r) => r.key === "action.addPeer");
    for (let i = 0; i < addPeerIndex; i++) model.handleInput("\u001b[B");
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
      // Navigate to identity.selfIdentity (last row before peers).
      const identityGroup = model.groups.find((g) => g.key === "identity")!;
      const selfIdx = model.groups.slice(0, model.groups.indexOf(identityGroup)).reduce((n, g) => n + g.rows.length, 0)
        + identityGroup.rows.findIndex((r) => r.key === "selfIdentity");
      for (let i = 0; i < selfIdx; i++) model.handleInput("\u001b[B");
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
      const identityGroup = model.groups.find((g) => g.key === "identity")!;
      const selfIdx = model.groups.slice(0, model.groups.indexOf(identityGroup)).reduce((n, g) => n + g.rows.length, 0)
        + identityGroup.rows.findIndex((r) => r.key === "selfIdentity");
      for (let i = 0; i < selfIdx; i++) model.handleInput("\u001b[B");
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
      // Navigate to the peer URL row (last row before peers group).
      const peersGroup = model.groups.find((g) => g.key === "peers")!;
      const peerIdx = model.groups.slice(0, model.groups.indexOf(peersGroup)).reduce((n, g) => n + g.rows.length, 0)
        + peersGroup.rows.findIndex((r) => r.key.startsWith("peer."));
      for (let i = 0; i < peerIdx; i++) model.handleInput("\u001b[B");
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
        SERVER: 11, DISCOVERY: 6, GATEWAY: 7, IDENTITY: 1, PEERS: 1, UI: 1,
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

    it("initial view shows SERVER whole; DISCOVERY follows whole (no split)", () => {
      // Since asyncTimeoutSec joined the SERVER group (#340), SERVER is 12
      // lines (header + 11 rows) and SERVER+DISCOVERY no longer fit the panel
      // kernel's 18-row budget together — screen 1 is SERVER alone, and the
      // next scroll step brings DISCOVERY whole. The property under test is
      // the 0.5.1 invariant: whole groups only, never a split group.
      const cfg = DEFAULTS();
      const model = new ConfigPanelModel(buildRows(cfg), null);
      const out = model.render(80).join("\n");
      assert.ok(out.includes("SERVER"), "SERVER header present");
      // Every SERVER row is on screen (group not truncated mid-way).
      for (const label of [
        "Server enabled", "Port", "Port fallback", "Bind host", "Agent name",
        "Reply timeout (s)", "Async timeout (s)", "Max concurrent",
        "Allow all users", "Max ping-pong turns", "Rate limit /min",
      ]) {
        assert.ok(out.includes(label), `SERVER row '${label}' visible on first screen`);
      }
      // Navigate until the window slides to DISCOVERY (the window follows the
      // selection; it slides once the cursor leaves the SERVER group).
      let out2 = "";
      for (let i = 0; i < 40 && !out2.includes("DISCOVERY"); i++) {
        model.handleInput("\u001b[B");
        out2 = model.render(80).join("\n");
      }
      assert.ok(out2.includes("DISCOVERY"), "DISCOVERY header reachable by scrolling");
      // Every discovery row is on screen (group not truncated mid-way).
      for (const label of ["Local registry", "Heartbeat (s)", "Registry TTL (s)", "mDNS broadcast", "mDNS service type", "Enrich Agent Card"]) {
        assert.ok(out2.includes(label), `DISCOVERY row '${label}' visible on the next screen`);
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
