# Changelog

All notable changes to `pi-obsidian` will be documented in this file.

## 0.8.11 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.8.10 (2026-07-24)

### Fixes

- Hoisted `property:set` argument validation before vault detection.

## 0.8.9 (2026-07-22)

### Fixes

- Closed remaining write silent-failure gaps and hardened cross-vault guards.

## 0.8.8 (2026-07-20)

### Fixes

- Fixed overwrite hang during sync and open-editor lifecycle.

## 0.8.6 (2026-07-16)

### Features

- `vaultWrite` base64+eval for write operations — eliminates all content escaping issues and argv length ceilings.

## 0.8.0 (2026-07-10)

### Features

- Initial 0.8 release with vault-discipline skill, cross-vault guards, and unified `obsidian` tool.
