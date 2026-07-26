---
name: kicad
description: Design KiCad schematics and PCB layouts via the Konnect bridge. Use when the user wants to create/edit KiCad schematics or PCBs, place and wire components, route traces, run ERC/DRC, export Gerbers/BOM/PDF/3D, search JLCPCB parts, use reference circuits, or do manufacturing prep. Trigger on "KiCad", "schematic", "PCB", "layout", "route traces", "ERC", "DRC", "Gerber", "BOM", "footprint", "design rule check", "pick-and-place", or any CAD/EDA design task.
---

# pi-kicad — KiCad CAD design via Konnect

Drive KiCad 10 through the **Konnect** binary using two Pi tools:

| Tool | Purpose |
|---|---|
| `kicad_call` | Invoke any Konnect tool by name (185 tools across 18 toolsets) |
| `kicad_status` | Wire up + health-check the bridge (binary, kicad-cli, IPC socket, daemon, version) |

## First move

If anything is unclear or a call fails, run `kicad_status` first. It resolves the
Konnect binary + `kicad-cli`, (re)starts the local HTTP daemon, and reports
whether the bridge is healthy. Restart with `restart: true` after changing KiCad
config or the IPC socket.

## The toolset-loading protocol (context economy)

Konnect exposes ~185 tools but loads only a small starter kit (~2K tokens, not
~23K). **Domain tools live in toolsets you must load before use:**

```
kicad_call tool=list_toolboxes                      → see all toolsets + counts
kicad_call tool=load_toolset arguments={name:"sch_components"}
kicad_call tool=add_schematic_component arguments={...}
kicad_call tool=unload_toolset arguments={name:"sch_components"}   → prune when done
```

If a tool errors with **"toolset not loaded"**, the message names the toolset —
call `load_toolset("<that>")` then retry. That single hop recovers every such error.

Toolsets: `project`, `sch_components`, `sch_wiring`, `sch_analysis`, `sch_batch`,
`sch_export`, `sch_hierarchy`, `pcb_board`, `pcb_components`, `pcb_routing`,
`pcb_export`, plus design-review, JLCPCB parts, Freerouting, reference circuits,
manufacturing. (Call `list_toolboxes` for the live list.)

## Two editing models — know which one you're in

- **Schematic** tools edit `.kicad_sch` files directly via Konnect's S-expression
  engine (atomic writes, UUID-safe). **No running KiCad needed.** Work headless.
- **PCB** tools talk to KiCad's IPC API. **Requires KiCad 10 open** with
  Preferences → Plugins → *Enable KiCad API*, and the target board loaded. PCB
  edits integrate with KiCad's undo/redo and appear live in the editor.

## Productive habits

- **Batch-first.** Prefer `batch_add_wire`, `batch_delete`,
  `bulk_move_schematic_components`, `batch_edit_schematic_components` — one file
  read/write cycle instead of N.
- **Let the tool compute coordinates.** `connect_pins` (route by reference+pin),
  `add_schematic_connection` (auto H+V between points), `connect_to_net` (stub +
  label) beat hand-placing every wire.
- **Validate as you go.** `validate_wire_connections`,
  `validate_component_connections`, `find_orphan_items`, `find_shorted_nets`
  catch placement errors immediately; don't wait for ERC.
- **Reference circuits as starters.** Load the reference-circuits toolset for
  verified USB-C / LDO / buck / STM32 / I2C / LED blocks instead of building from scratch.
- **JLCPCB parts.** Use the JLCPCB toolset to find in-stock footprints/symbols and
  alternatives from the local 2.5M-part catalog.
- **Visual feedback.** `get_schematic_view` / `get_board_2d_view` render PNGs;
  `open_schematic_viewer` launches the live auto-refresh viewer.
- **Self-diagnose.** `get_recent_calls` and `server_stats` show the last tool
  calls, durations, and errors — use them when a tool misbehaves.

## Standard design flow

```
create_project / open_project
  → schematic capture (sch_components, sch_wiring)
  → annotate_schematic            (R? → R1, U? → U1)
  → run_erc  →  fix violations    (sch_analysis tools find orphans/shorts)
  → update PCB from schematic
  → layout (pcb_components) → route (pcb_routing) → copper pours / mounting holes (pcb_board)
  → get_drc_violations  →  fix    →  refill_zones
  → export_gerber / export_pdf / export_bom / export_position_file / export_3d
```

Snapshot before risky edits with `snapshot_project` (exports a timestamped PDF).

## Known Konnect v0.2.0 limitations (work around these)

These are Konnect (third-party Rust binary) bugs, not pi-kicad bugs. pi-kicad works
around them where it can:

- **Standard symbol libraries don't resolve.** Konnect's `.kicad_sym` parser
  returns 0 symbols from KiCad 10's standard libraries (Device, power, …), so
  `add_schematic_component Device:R`, `power:GND`, etc. all fail. **Build every
  symbol from scratch with `create_symbol`** in a `.kicad_sym` inside the project,
  then place `dcdc:<Name>`.
- **`add_schematic_component` resolves lib_id ONLY via `KICAD10_SYMBOL_DIR`**
  (a single dir set at daemon start, NOT the sym-lib-table). pi-kicad ALWAYS
  points it at its **managed symbol dir `~/.pi/kicad-symbols`** (created
  automatically). So **create your from-scratch symbols there**: `create_symbol`
  with `library_path=~/.pi/kicad-symbols/<lib>.kicad_sym`, then place
  `<lib>:<sym>`. No env var or project-dir setup needed — `kicad_status` prints
  the symbol dir. (The daemon never reuses a stale stranger daemon, so it always
  runs with the correct env.)
- **`register_symbol_library` writes the wrong table format** (`(fp_lib_table …)`
  into `sym-lib-table`). Hand-write `sym-lib-table` as `(sym_lib_table …)` if ERC
  warns "configuration does not include the symbol library".
- **`list_symbols_in_library` mangles names** (strips the first char: `Res`→`es`).
  Placement lookup is unaffected — place by the real lib_id.
- **`delete_symbol` reports success but doesn't persist**; `annotate_schematic`
  reports success but leaves references as `?`. **Pass explicit `reference`**
  (e.g. `R1`, `U1`) when placing, and don't rely on annotate/delete.
- **Wiring by net label is the robust path.** `connect_to_net` needs `pin_x`/`pin_y`
  (not pin numbers): call `get_schematic_pin_locations` (or
  `batch_get_schematic_pin_locations`) first, then
  `connect_to_net {schematic, pin_x, pin_y, net}` per pin — it adds a **wire stub
  + label** that KiCad attaches. Use all-`passive` pin types to keep ERC focused
  on connectivity (avoids power-pin driver rules when power symbols are
  unavailable).
  - **⚠ Do NOT use `batch_connect_to_net`** — in Konnect v0.2.0 it places *bare*
    net labels at pin coords with **no wire stub**, so they FLOAT and do not
    connect. ERC won't catch it (passive pins aren't flagged) and
    `list_schematic_nets` just reads label names. Always use `connect_to_net`.
  - **Verify connectivity with `get_net_connectivity` or the kicad-cli netlist**
    (`generate_netlist`) — NOT `run_erc` alone (passive pins hide unconnected
    pins) and NOT `list_schematic_nets` (label names ≠ attached).
  - **For VISIBLE wires between components** (a real schematic, not just
    connect-by-name), use **`connect_pins {schematic, ref1, pin1, ref2, pin2}`**
    which routes an actual wire (L-bend) between two pins. Chain/star same-net
    pins (e.g. star each net through the regulator). `connect_to_net` only adds
    a short stub+label (connect-by-name, no inter-component wire) — fine for
    naming a net, but pair it with `connect_pins` when real wires are expected.
    Render to PDF/PNG and eyeball it (or ask a vision model) to confirm.
- **PCB tools need KiCad 10 running** with its API enabled; schematic/export tools
  are file-based and work headless.
- **Never call file-mutating Konnect tools in parallel** (multiple kicad_call in one
  message run concurrently). Konnect's read-modify-write + atomic-rename races:
  concurrent calls lose edits or fail with "No such file or directory" and can
  corrupt the file (duplicates, lost symbols). **Use `kicad_batch`** for any
  multi-step flow — it runs the ops strictly sequentially (each awaited). Inside
  one Konnet tool, prefer the batch_* variants (e.g. `batch_connect_to_net` does
  a whole net's pins in a single file write).
