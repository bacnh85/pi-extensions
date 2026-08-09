# Changelog

## 0.1.28 (2026-08-09)

### Improvements

- **Command Code monthly balance now shown in the footer.** The footer adds a
  compact `M:$X.XX` segment (monthly credit balance from
  `/alpha/billing/credits`) next to the 5-hour/weekly windows, e.g.
  `(Command Code key#…) R:100%/5H W:100%/7D M:$69.99`. The `/sub` detail view
  keeps the `Monthly: $X remaining` breakdown line.

## 0.1.27 (2026-08-09)

### Features

- **Command Code now shows live usage windows.** The adapter fetches
  `https://api.commandcode.ai/alpha/billing/credits` with the same Provider
  API key used for `/provider/v1` models and renders the 5-hour and weekly
  rolling windows (USD used/cap, remaining% + reset countdown) plus a
  `Monthly: $X remaining` balance line — matching what the `cmd /usage` CLI
  shows. Previously the footer showed session cost only.

## 0.1.26 (2026-08-09)

### Features

- Added Command Code (`commandcode`) provider support. When a `commandcode`
  model is active, the footer shows the account label plus session cost and
  tok/s, and `/sub` reports the provider. Command Code's Provider API does not
  expose usage windows via its API key (the rolling-window data is
  web-session-cookie only), so live 5h/weekly meters are not shown — behavior
  matches `opencode-go` and `9router`.

## 0.1.25 (2026-08-07)

### Improvements

- Widen peer dependency range to support Pi 0.84.0 (`>=0.80.8 <0.85.0`).
  No code changes — verified compatible against the 0.84.0 SDK types.

## 0.1.24 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

All notable changes to `pi-sub` will be documented in this file.

## 0.1.23 (2026-07-30)

### Improvements

- Widen Pi peer dependency range to <0.84.0 for Pi 0.83.0 compatibility.

## 0.1.22 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.1.21 (2026-07-24)

### Features

- Added 9router adapter for tokens per second (tok/s) and endpoint display.
- Cleared stale context on session shutdown to prevent crashes on `/new`.

## 0.1.15 (2026-07-16)

### Features

- Added `zai-coding-cn` (Z.ai China / open.bigmodel.cn) usage monitoring.
- Surfaced Z.ai MCP/month + per-model usage in `/sub` detail view.

## 0.1.10 (2026-07-10)

### Features

- Added tok/s (tokens per second) display for response speed tracking.

## 0.1.0 (2026-07-05)

### Features

- Initial release of `pi-sub` subscription usage footer extension.
