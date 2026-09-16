# Changelog

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
