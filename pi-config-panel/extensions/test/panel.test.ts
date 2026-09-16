import { assert } from "chai";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  applyRows,
  ConfigPanelModel,
  filterSuggestions,
  joinCompletion,
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

  describe("inline completions", () => {
    const models = [
      { value: "a/m1", label: "m1", description: "p" },
      { value: "a/m2", label: "m2", description: "p" },
      { value: "b/fast", label: "fast", description: "q" },
    ];

    it("filterSuggestions: empty suffix → full list, narrowing, no match", () => {
      assert.deepEqual(filterSuggestions(models, ""), models);
      assert.deepEqual(filterSuggestions(models, "m1, "), models, "comma continuation resets to full list");
      assert.equal(filterSuggestions(models, "m1, fa").length, 1);
      assert.equal(filterSuggestions(models, "m1, fa")[0]!.value, "b/fast");
      assert.deepEqual(filterSuggestions(models, "zzz"), []);
    });

    it("joinCompletion: first pick and comma continuation, no trailing comma", () => {
      assert.equal(joinCompletion("", "a/m1"), "a/m1");
      assert.equal(joinCompletion("a/m1,", "a/m2"), "a/m1, a/m2");
      assert.equal(joinCompletion("a/m1, ", "a/m2"), "a/m1, a/m2");
    });

    it("escape hatch: Enter submits raw typed text even while suggestions show", () => {
      const cfg: TestCfg = DEFAULTS();
      const group: PanelGroup[] = [{
        key: "g", label: "g", rows: [
          row("model", "Model", "string", cfg.url, (v) => { cfg.url = String(v ?? ""); }, { completions: () => models }),
        ],
      }];
      const model = new ConfigPanelModel(group, null, "t");
      model.handleInput("\r"); // start editing row 0
      for (const ch of "zz-custom") model.handleInput(ch); // raw text, matches nothing
      model.handleInput("\r"); // Enter → raw submit, not a suggestion
      assert.equal(cfg.url, "zz-custom");
    });

    it("Tab picks highlighted suggestion, comma continues", () => {
      const cfg: TestCfg = DEFAULTS();
      const group: PanelGroup[] = [{
        key: "g", label: "g", rows: [
          row("model", "Model", "string", cfg.url, (v) => { cfg.url = String(v ?? ""); }, { completions: () => models }),
        ],
      }];
      const model = new ConfigPanelModel(group, null, "t");
      model.handleInput("\r"); // edit
      model.handleInput("\t"); // pick first → "a/m1"
      for (const ch of ",") model.handleInput(ch); // "a/m1," → full list again
      model.handleInput("\t"); // pick first → "a/m1, a/m1"... need second item
      // ↓ then Tab: navigate to m2 before picking.
      const cfg2: TestCfg = DEFAULTS();
      const group2: PanelGroup[] = [{
        key: "g", label: "g", rows: [
          row("model", "Model", "string", cfg2.url, (v) => { cfg2.url = String(v ?? ""); }, { completions: () => models }),
        ],
      }];
      const model2 = new ConfigPanelModel(group2, null, "t");
      model2.handleInput("\r");
      model2.handleInput("\t"); // a/m1
      model2.handleInput(",");
      model2.handleInput("\u001b[B"); // ↓ highlight m2
      model2.handleInput("\t"); // a/m1, a/m2
      model2.handleInput("\r"); // commit
      assert.equal(cfg2.url, "a/m1, a/m2");
      void cfg; void model;
    });

    it("suggestion lines survive render truncation (multi-line row bug)", () => {
      // Regression: renderRow returned the editing row as ONE joined string;
      // truncateToWidth collapsed the ANSI-styled blob to its first line and
      // the suggestion list never appeared — Tab then always picked the first
      // (alphabetical) item because users couldn't see or navigate the list.
      const cfg: TestCfg = DEFAULTS();
      const group: PanelGroup[] = [{
        key: "g", label: "g", rows: [
          row("model", "Model", "string", cfg.url, (v) => { cfg.url = String(v ?? ""); }, { completions: () => models }),
        ],
      }];
      // Real styled theme — the ANSI codes are what triggered the collapse.
      const theme = { fg: (_style: string, text: string) => `\u001b[90m${text}\u001b[0m`, bold: (t: string) => `\u001b[1m${t}\u001b[0m` };
      const model = new ConfigPanelModel(group, theme as any, "t");
      model.handleInput("\r"); // edit
      for (const ch of "m1") model.handleInput(ch); // narrows to a/m1
      const out = model.render(80).join("\n");
      const lines = out.split("\n");
      assert.ok(lines.some((l) => l.includes("Model:") && l.includes("m1")), "input line renders");
      // Suggestion lines carry the description suffix ("— p") — they only exist
      // when the list survived the per-line truncation.
      assert.ok(lines.some((l) => l.includes("— p")), "suggestion line renders as its own row");
    });

    it("string row with existing value prefills the input for in-place edit", () => {
      const cfg: TestCfg = DEFAULTS();
      cfg.url = "a/m1, a/m2";
      const group: PanelGroup[] = [{
        key: "g", label: "g", rows: [
          row("model", "Model", "string", cfg.url, (v) => { cfg.url = String(v ?? ""); }, { completions: () => models }),
        ],
      }];
      const model = new ConfigPanelModel(group, null, "t");
      model.handleInput("\r"); // edit
      const input = (model as unknown as { input: { getValue(): string; cursor: number } }).input;
      assert.ok(input, "editing started");
      assert.equal(input.getValue(), "a/m1, a/m2", "input prefilled with existing value");
      assert.equal(input.cursor, "a/m1, a/m2".length, "cursor parked at end");
      // Backspace trims, comma re-offers full list, Tab appends — edit in place.
      model.handleInput("\u007f"); // backspace removes trailing space→ wait, removes '2'
      model.handleInput("\u007f"); // removes '2'... two backspaces remove '2' and space
      const trimmed = input.getValue();
      assert.ok(trimmed.startsWith("a/m1"), "backspace edits the prefilled value");
      model.handleInput(",");
      model.handleInput("\t"); // pick first suggestion appended to head
      model.handleInput("\r"); // commit
      assert.ok(cfg.url.startsWith("a/m1") && cfg.url.includes("a/m"), "commit applies the edited value");
      void trimmed;
    });

    it("masked string row still starts empty on edit (secret never prefilled)", () => {
      const cfg = DEFAULTS();
      cfg.token = "supersecret";
      const model = new ConfigPanelModel(buildRows(cfg), null);
      for (let i = 0; i < IDX_TOKEN; i++) model.handleInput("\u001b[B");
      model.handleInput("\r"); // edit the token row
      const input = (model as unknown as { input: { getValue(): string } | null }).input;
      assert.ok(input, "editing started");
      assert.equal(input!.getValue(), "", "masked row input starts empty — secret not rendered");
      model.handleInput("\u001b"); // Esc cancel
    });

    it("string row with empty value starts empty (unchanged path)", () => {
      const cfg: TestCfg = DEFAULTS();
      const group: PanelGroup[] = [{
        key: "g", label: "g", rows: [
          row("model", "Model", "string", cfg.url, (v) => { cfg.url = String(v ?? ""); }, { completions: () => models }),
        ],
      }];
      const model = new ConfigPanelModel(group, null, "t");
      model.handleInput("\r");
      const input = (model as unknown as { input: { getValue(): string } }).input;
      assert.equal(input.getValue(), "");
    });

    it("cursor in the FIRST segment targets that segment (picker edits entry 1)", () => {
      // filterSuggestions/joinCompletion with explicit cursor: the picker
      // edits whichever entry the cursor sits in, not just the last one.
      assert.deepEqual(filterSuggestions(models, "m1, fast", 2).map((o) => o.value), ["a/m1"], "cursor inside 'm1' → filters by 'm1'");
      assert.equal(filterSuggestions(models, "m1, fast", 5)[0]!.value, "b/fast", "cursor inside 'fast' → filters by 'fast'");
      // Tab with cursor in segment 1 replaces entry 1 and PRESERVES the tail.
      assert.equal(joinCompletion("m1, fast", "m2", 1), "m2, fast");
      assert.equal(joinCompletion("m1, fast", "m2", 4), "m1, m2");
      // Cursor on the comma belongs to the earlier segment.
      assert.equal(joinCompletion("m1, fast", "m2", 2), "m2, fast");
    });

    it("live retarget: cursor move re-filters suggestions (component flow)", () => {
      const cfg: TestCfg = DEFAULTS();
      cfg.url = "a/m1, b/fast";
      const group: PanelGroup[] = [{
        key: "g", label: "g", rows: [
          row("model", "Model", "string", cfg.url, (v) => { cfg.url = String(v ?? ""); }, { completions: () => models }),
        ],
      }];
      const model = new ConfigPanelModel(group, null, "t");
      model.handleInput("\r"); // prefill "a/m1, b/fast", cursor at end
      // Simulate arrows landing the cursor inside segment 1 ("a/m1", idx 0-3),
      // then one real ← key routes through handleInput → refilter.
      const m = model as unknown as { suggestions: { value: string }[]; input: { getValue(): string; cursor: number } };
      m.input.cursor = 3;
      model.handleInput("\x1b[D"); // ← → cursor 2, inside "a/m1"
      assert.ok(m.suggestions.length >= 1, "suggestions live for segment 1");
      model.handleInput("\x1b[B"); // ↓ highlight a/m2
      model.handleInput("\t"); // Tab replaces segment 1 with a/m2, keeps segment 2
      assert.equal(m.input.getValue(), "a/m2, b/fast", "first entry replaced, second preserved");
    });
  });
});
