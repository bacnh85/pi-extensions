# Changelog

## 0.2.2 - 2026-09-28

- Regression test for the 0.2.1 var-to-var rejection: a var whose value is
  another var name must fail validation naming both vars.
- README: note that `npm test` runs the theme validator; annotate the missing
  catppuccin-mocha preview PNG.

## 0.2.1 - 2026-09-26

- Theme validator now checks `vars` VALUES, not just names: each var must be a
  6-digit hex, an integer 0–255, or `""` (terminal default); var-to-var
  references are rejected. Previously `{"vars":{"accent":"red"}}` or
  out-of-range numbers (e.g. `999`) passed validation and shipped broken.
- Added regression tests (`node --test`) for bad, out-of-range, and valid var
  values.

## 0.2.0 - 2026-09-10

Added `pi-catppuccin-mocha` — Catppuccin Mocha palette, chosen to blend Pi panes with
[herdr](https://herdr.dev/)'s default `catppuccin` theme (same base/text/mauve accent).
Surfaces use official Mocha tones (crust/mantle/surface0); the tool box
backgrounds are exact 256-palette indices (neutral darks, 233/234/236) so they render
identically in terminal multiplexers that override pane color env (herdr, #554); the
only other derived color is the export info background (crust +10% mauve).

## 0.1.1 - 2026-08-08

Migrated package into the pi-extensions monorepo. Repointed homepage, repository,
bugs, and preview image URLs to this repo; fixed `$schema` URLs to the canonical
earendil-works/pi location; corrected the mirage background value in the README.

## 0.1.0

Initial release (from bacnh85/skills): three Ayu-based variants (dark, mirage,
light) with 51 color tokens each plus HTML-export colors.
