# Changelog

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
