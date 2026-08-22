# pi-config-panel

Shared interactive config-panel kernel for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extensions — the arrow-key toggle/edit overlay panel behind `pi-a2a`'s `/a2a-config`, extracted as a library so every extension gets the same panel without duplicating TUI code.

**Pure library** — no `pi` field in package.json, installs nothing into Pi itself. Consumer extensions declare `@bacnh85/pi-config-panel` as a dependency and Pi resolves it transitively at load time.

## Usage

```typescript
import { openConfigPanel, row, type BuildRows } from "@bacnh85/pi-config-panel";

interface MyCfg { baseUrl: string; port: number; enabled: boolean; }

const build: BuildRows<MyCfg> = (cfg, actions) => [
  {
    key: "main", label: "Main", rows: [
      row("baseUrl", "Base URL", "string", cfg.baseUrl, (v) => { cfg.baseUrl = String(v ?? ""); }),
      row("port", "Port", "number", cfg.port, (v) => { cfg.port = Number(v) || cfg.port; }),
      row("enabled", "Enabled", "toggle", cfg.enabled, (v) => { cfg.enabled = Boolean(v); }),
    ],
  },
];

pi.registerCommand("my-config", {
  handler: async (_args, ctx) => {
    const working = structuredClone(currentCfg);
    await openConfigPanel({ ctx, cfg: working, build, title: "My Extension", onSave: (saved) => {
      if (saved) persistToSettingsJson(working);
    }});
  },
});
```

## API

| Export | What it does |
|---|---|
| `openConfigPanel(opts)` | Open the panel via `ctx.ui.custom`; resolves on close. Esc saves when dirty. |
| `ConfigPanelModel` | The TUI component (headless-testable — all kernel tests drive it without a TUI). |
| `row(key, label, kind, value, set, opts?)` | Row factory; setter syncs both the backing config and `row.value`. `opts.mask` hides secrets (`••••`, blank submit keeps the old value). |
| `toInt(v, fallback)` | Integer coercion keeping the fallback on garbage. |
| `applyRows(cfg, groups)` | Re-apply every row's value (tests / "apply" flows). |
| `kindValue(kind, raw)` | Coerce a raw input string to a toggle/number/string value. |
| `makeOnAction(model, cfg, build, actions, onError)` | Action-row handler factory (rebuilds rows after add/remove actions). |
| `PanelRow` / `PanelGroup` / `PanelAction` / `BuildRows<T>` | Row-model types. |

## Rules the kernel enforces (learned the hard way)

- **No nested dialogs.** The panel never calls `ctx.ui.input()/select()/confirm()` while displayed — they render *under* the overlay and fight its focus. Action rows use the built-in inline `prompt()` instead; string/number rows edit inline via an embedded `Input`.
- **Esc = save & close** when dirty (no confirmation dialog); Esc inside an inline edit cancels the edit.
- **Whole-group windowing** — a group header never renders without all its rows.
- **Width-safe render** — every line is truncated to the overlay width (the TUI throws on wider lines).
- **Secrets stay masked** — masked rows never render the raw value; an empty submit keeps the existing secret instead of wiping it.

## Config placement convention (for consumer extensions)

- Non-secret config (`baseUrl`, toggles, ports) → `settings.json` under the extension's key (`router.baseUrl`, `commandcode.baseUrl`, …). Never write to a repo-controlled `.pi/settings.json`.
- Secrets / API keys → `auth.json` via Pi's built-in `/login` (`apiKey: "$ENV_VAR"` provider pattern). Never settings.json.

## Development

```bash
npm test        # mocha + tsx (cd extensions && mocha)
npm run typecheck
```
