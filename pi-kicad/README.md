# @bacnh85/pi-kicad

KiCad CAD-design extension for the [Pi coding agent](https://github.com/earendil-works/pi).
Design schematics and PCB layouts by driving the [**Konnect**](https://github.com/mixelpixx/Konnect)
binary — **no MCP SDK, no generic MCP client**. Konnect is launched once in its
built-in HTTP mode as a managed local daemon, and each tool call is a single
stateless `POST /mcp` JSON-RPC request.

## Tools

| Tool | Purpose |
|---|---|
| `kicad_call` | Invoke any of Konnect's 185 tools by name (schematic capture, layout, routing, ERC/DRC, exports, design review, JLCPCB parts, Freerouting, reference circuits). |
| `kicad_status` | Resolve the Konnect binary, `kicad-cli`, and IPC socket; start/health-check the daemon; report version + active tool count. Use first when something isn't working. |

Konnect loads only a small toolset starter kit for context economy. Call
`list_toolboxes` → `load_toolset("<name>")` before domain tools; `unload_toolset`
to prune. See the bundled **kicad** skill for the full design workflow.

## Prerequisites

- **KiCad 10** — Konnect's PCB tools use the v10 IPC API. Schematic + export tools
  work without KiCad running.
- **The Konnect binary** — install separately (this package does **not** vendor it):
  - KiCad 10 → Plugin and Content Manager → *Install from File* → the `konnect-pcm-*` zip for your OS, **or**
  - a [GitHub release](https://github.com/mixelpixx/Konnect/releases) tarball.
  - macOS browser download: clear quarantine first — `xattr -d com.apple.quarantine ./konnect`.
- For PCB layout/routing: open KiCad 10 and enable **Preferences → Plugins → "Enable KiCad API"**, with the target board open.

## Configuration

All optional — auto-discovered. Override with environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `KONNECT_BINARY` (or `KICAD_BINARY`) | auto (KiCad 10 PCM path, then release cache) | Path to the `konnect` binary |
| `KICAD_CLI` | auto (app bundle / `/usr/bin` / Program Files) | Path to `kicad-cli` |
| `KICAD_API_SOCKET` | Konnect auto-detect | KiCad IPC socket, e.g. `ipc:///tmp/kicad/api.sock` |
| `KICAD_HTTP_PORT` | `31337` | Preferred daemon port (falls back to a free one) |
| `KICAD_LOG_LEVEL` | `info` | Konnect log level (error/warn/info/debug/trace) |

## How it works

```
Pi agent ── kicad_call ──► POST http://127.0.0.1:<port>/mcp   ──► Konnect daemon (HTTP mode)
                                                                         │
                                          ┌──────────────────────────────┴───┐
                                          ▼                                   ▼
                              .kicad_sch S-expr engine               KiCad 10 IPC API (NNG)
                              (atomic writes, no UI)                 (PCB edits, undo-aware)
                                                  │
                                                  ▼
                                         kicad-cli subprocess
                                         (ERC, DRC, Gerber, PDF, BOM, 3D…)
```

The daemon is reused if a healthy one is already running on the port; otherwise
`pi-kicad` spawns `konnect --config <tmp-toml>` (transport=`http`), polls
`GET /health`, and kills it on Pi exit.

## License

This package is **MIT**. Konnect is **AGPL-3.0** (free for hobbyists/students/OS;
commercial license otherwise). `pi-kicad` communicates with Konnect as a separate
process over a standard local protocol — it does not bundle or link Konnect, so it
is not a derivative work. The Konnect binary remains a user-installed prerequisite.
