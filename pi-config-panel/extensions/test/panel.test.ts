import { assert } from "chai";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  applyRows,
  ConfigPanelModel,
  kindValue,
  makeOnAction,
  row,
  type PanelAction,
  type PanelGroup,
} from "../lib/panel";

// ---------------------------------------------------------------------------
// Minimal generic fixture: a settings object + buildRows, standing in for any
// extension's config (no A2A shapes — the kernel must be extension-agnostic).
// ---------------------------------------------------------------------------

interface TestCfg {
  enabled: boolean;
  port: number;
  url: string;
  token: string;
  entries: Record<string, string>;
}

function DEFAULTS(): TestCfg {
  return { enabled: false, port: 8000, url: "", token: "", entries: {} };
}

function buildRows(cfg: TestCfg, actions: Record<string, PanelAction> = {}): PanelGroup[] {
  const rows = [
    row("enabled", "Enabled", "toggle", cfg.enabled, (v) => {
      cfg.enabled = Boolean(v);
    }),
    row("port", "Port", "number", cfg.port, (v) => {
      cfg.port = typeof v === "number" ? v : parseInt(String(v), 10) || cfg.port;
    }),
    row("url", "URL", "string", cfg.url, (v) => {
      cfg.url = String(v ?? "");
    }),
    row("token", "Token", "string", cfg.token, (v) => {
      cfg.token = String(v ?? "");
    }, { mask: true }),
  ];
  const entryRows = Object.entries(cfg.entries).map(([k, v]) =>
    row(`entry.${k}`, `Entry ${k}`, "string", v, (nv) => {
      cfg.entries[k] = String(nv ?? "");
    }),
  );
  if (actions.addEntry) {
    entryRows.push({ key: "action.addEntry", label: "+ Add entry", kind: "action", value: undefined, set: (p) => actions.addEntry!.run(p as never) });
  }
  return [
    { key: "main", label: "Main", rows },
    { key: "entries", label: "Entries", rows: entryRows },
  ];
}

// Row index helpers: main(4) then entries.
const IDX_PORT = 1;
const IDX_URL = 2;
const IDX_TOKEN = 3;

describe("panel kernel", () => {
  it("row() setter updates both the backing config and row.value", () => {
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    const r = groups[0]!.rows[0]!;
    assert.equal(r.value, false);
    r.set(true);
    assert.equal(cfg.enabled, true);
    assert.equal(r.value, true, "row.value must track the backing config");
    r.set(false);
    assert.equal(r.value, false);
  });

  it("number row set coerces strings and keeps fallback on garbage", () => {
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    const portRow = groups[0]!.rows[IDX_PORT]!;
    portRow.set("9933");
    assert.equal(cfg.port, 9933);
    portRow.set("not-a-number");
    assert.equal(cfg.port, 9933); // keeps prior value
  });

  it("applyRows applies every row onto the config", () => {
    const cfg = DEFAULTS();
    const groups = buildRows(cfg);
    groups[0]!.rows[0]!.value = true;
    groups[0]!.rows[IDX_PORT]!.value = 9944;
    groups[0]!.rows[IDX_URL]!.value = "http://x";
    applyRows(cfg, groups);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.port, 9944);
    assert.equal(cfg.url, "http://x");
  });

  it("masked rows render no raw secret; row.value still carries it", () => {
    const cfg = DEFAULTS();
    cfg.token = "supersecret";
    const model = new ConfigPanelModel(buildRows(cfg), null);
    for (let i = 0; i < IDX_TOKEN; i++) model.handleInput("\u001b[B");
    const out = model.render(80).join("\n");
    assert.ok(!out.includes("supersecret"), "raw token must not appear");
    assert.match(out, /••••/);
    assert.equal(buildRows(cfg)[0]!.rows[IDX_TOKEN]!.value, "supersecret");
  });

  it("empty submit on a masked row keeps the existing secret (no wipe)", () => {
    const cfg = DEFAULTS();
    cfg.token = "supersecret";
    const model = new ConfigPanelModel(buildRows(cfg), null);
    model.onChanged = () => { model.dirty = true; };
    for (let i = 0; i < IDX_TOKEN; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // start edit
    model.handleInput("\r"); // submit EMPTY → must keep the secret
    assert.equal(cfg.token, "supersecret", "empty submit keeps the token");
    assert.isFalse(model.dirty, "no change recorded");
  });

  it("navigates with arrow keys and toggles on Enter", () => {
    const cfg = DEFAULTS();
    const model = new ConfigPanelModel(buildRows(cfg), null);
    let renders = 0;
    model.onRequestRender = () => { renders++; };
    model.handleInput("\u001b[B"); // down
    model.handleInput("\u001b[A"); // up → back to row 0
    model.handleInput("\r"); // enter → toggle
    assert.equal(cfg.enabled, true);
    assert.isTrue(model.dirty);
    assert.isAtLeast(renders, 3);
  });

  it("edits a string row via the inline input", () => {
    const cfg = DEFAULTS();
    const model = new ConfigPanelModel(buildRows(cfg), null);
    model.onChanged = () => { model.dirty = true; };
    for (let i = 0; i < IDX_URL; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // start inline edit
    for (const ch of "http://new") model.handleInput(ch);
    model.handleInput("\r"); // submit
    assert.equal(cfg.url, "http://new");
    assert.isTrue(model.dirty);
  });

  it("edits a number row with coercion", () => {
    const cfg = DEFAULTS();
    const model = new ConfigPanelModel(buildRows(cfg), null);
    for (let i = 0; i < IDX_PORT; i++) model.handleInput("\u001b[B");
    model.handleInput("\r");
    for (const ch of "9933") model.handleInput(ch);
    model.handleInput("\r");
    assert.equal(cfg.port, 9933);
  });

  it("Esc during inline edit cancels without changing the value", () => {
    const cfg = DEFAULTS();
    const model = new ConfigPanelModel(buildRows(cfg), null);
    for (let i = 0; i < IDX_URL; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // start edit
    for (const ch of "changed") model.handleInput(ch);
    model.handleInput("\u001b"); // cancel edit
    assert.equal(cfg.url, ""); // unchanged
    assert.isFalse(model.dirty);
  });

  it("Esc invokes onClose", () => {
    const model = new ConfigPanelModel(buildRows(DEFAULTS()), null);
    let closed = 0;
    model.onClose = () => { closed++; };
    model.handleInput("\u001b");
    assert.equal(closed, 1);
  });

  it("render never exceeds the given width, even with a long value", () => {
    const cfg = DEFAULTS();
    cfg.url = "http://a-really-long-host.example.com:9999/some/deep/path?with=query&and=more";
    const model = new ConfigPanelModel(buildRows(cfg), null);
    const width = 60;
    for (const line of model.render(width)) {
      assert.ok(visibleWidth(line) <= width, "line too wide: " + line);
    }
  });

  it("truncates during inline edit (long value + hint)", () => {
    const cfg = DEFAULTS();
    cfg.url = "http://a-really-long-host.example.com:9999/some/deep/path?with=query&and=more";
    const model = new ConfigPanelModel(buildRows(cfg), null);
    for (let i = 0; i < IDX_URL; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // start edit
    const width = 60;
    for (const line of model.render(width)) {
      assert.ok(visibleWidth(line) <= width, "edit line too wide: " + line);
    }
  });

  it("renders whole groups — a header never appears without its full rows", () => {
    const cfg = DEFAULTS();
    // 15 entries → main(4) + entries(15) exceeds MAX_VISIBLE_ROWS(18), so
    // windowing must engage: main fits alone (1+4), entries splits the screen.
    cfg.entries = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [String.fromCharCode(97 + i), `v${i}`]),
    );
    const model = new ConfigPanelModel(buildRows(cfg), null);
    const headerRe = /^[A-Z][A-Z ]*$/;
    const expected: Record<string, number> = { MAIN: 4, ENTRIES: 15 };
    for (let step = 0; step < 8; step++) {
      const lines = model.render(80);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i]!;
        if (headerRe.test(line.trim()) && expected[line.trim()] !== undefined) {
          const name = line.trim();
          const count = expected[name]!;
          for (let j = 1; j <= count; j++) {
            const r = lines[i + j];
            assert.isDefined(r, `group ${name} row ${j} missing at step ${step}`);
            assert.ok(
              !headerRe.test(r!.trim()) || expected[r!.trim()] === undefined,
              `group ${name} split: header '${r}' inside its rows at step ${step}`,
            );
          }
        }
        i++;
      }
      for (let k = 0; k < 3; k++) model.handleInput("\u001b[B");
    }
  });

  it("custom title renders instead of the default", () => {
    const model = new ConfigPanelModel(buildRows(DEFAULTS()), null, "Command Code Configuration");
    const out = model.render(80).join("\n");
    assert.ok(out.includes("Command Code Configuration"));
    assert.ok(!out.includes("A2A"));
  });

  it("action rows run the provided action", async () => {
    const cfg = DEFAULTS();
    let ran = 0;
    const groups = buildRows(cfg, {
      addEntry: { label: "Add entry", run: () => { ran++; } },
    });
    const actionRow = groups[1]!.rows.find((r) => r.key === "action.addEntry")!;
    assert.equal(actionRow.kind, "action");
    await actionRow.set(undefined);
    assert.equal(ran, 1);
  });

  it("add-entry action rebuilds rows through the production onAction wiring", async () => {
    const cfg = DEFAULTS();
    const actions: Record<string, PanelAction> = {
      addEntry: {
        label: "Add entry",
        // Resolves only after the LAST prompt's onDone — mirrors extension usage.
        run: (prompt) => {
          return new Promise<void>((resolve) => {
            prompt("Entry key", (key) => {
              if (!key) return resolve();
              prompt(`Value for '${key}'`, (value) => {
                if (!value) return resolve();
                cfg.entries[key] = value;
                resolve();
              });
            });
          });
        },
      },
    };
    const model = new ConfigPanelModel(buildRows(cfg, actions), null);
    model.onAction = makeOnAction(model, cfg, buildRows, actions, () => {});
    assert.ok(!model.groups[1].rows.some((r) => r.key.startsWith("entry.")), "no entry rows before add");
    // Navigate to the action row: main(4 rows) = index 4.
    for (let i = 0; i < 4; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // activate → prompt opens
    for (const ch of "new1") model.handleInput(ch);
    model.handleInput("\r"); // confirm key
    for (const ch of "val1") model.handleInput(ch);
    model.handleInput("\r"); // confirm value
    await new Promise((r) => setTimeout(r, 0)); // flush onAction continuation
    const keys = model.groups[1].rows.map((r) => r.key);
    assert.ok(keys.includes("entry.new1"), "new entry rows appear after rebuild: " + keys.join(","));
    assert.equal(cfg.entries.new1, "val1");
    assert.isTrue(model.dirty, "action marks the panel dirty");
  });

  it("prompt flow: action receives the typed value via inline prompt; Esc cancels", () => {
    const cfg = DEFAULTS();
    const model = new ConfigPanelModel(buildRows(cfg, {
      addEntry: {
        label: "Add entry",
        run: (prompt) => {
          prompt("Entry key", (key) => {
            if (key) cfg.entries[key] = "x";
          });
        },
      },
    }), null);
    model.onAction = async (r) => {
      await r.set((label: string, onDone: (v: string | undefined) => void) => {
        model.prompt(label, onDone);
      });
      model.requestRender();
    };
    for (let i = 0; i < 4; i++) model.handleInput("\u001b[B");
    model.handleInput("\r"); // activate
    for (const ch of "keep") model.handleInput(ch);
    model.handleInput("\r"); // confirm
    assert.equal(cfg.entries.keep, "x");
    // Second pass: Esc during prompt cancels.
    for (let i = 0; i < 4; i++) model.handleInput("\u001b[B"); // re-navigate to action row
    model.handleInput("\r");
    for (const ch of "cancel") model.handleInput(ch);
    model.handleInput("\u001b"); // cancel
    assert.isUndefined(cfg.entries.cancel);
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
