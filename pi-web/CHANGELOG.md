# Changelog

## 0.6.0 (2026-08-07)

### Features

- **agy extraction backend:** `web_extract` gains a new `agy` mode that uses the Antigravity CLI (Gemini/Claude) native `read_url` web tool to fetch bot-protected and anti-AI-scraping pages that block Firecrawl/Crawl4AI. `auto` mode now falls back static → dynamic → full → agy; explicit `mode: "agy"` forces it. Structured extraction (`prompt`/`schema`) is supported. `web_status` reports `agy.installed`.
- agy is optional and self-contained: if the CLI is not installed, `auto` mode skips it silently and existing flows are unchanged. Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then authenticate once with `agy`.

All notable changes to `pi-web` will be documented in this file.

## 0.5.7 (2026-08-05)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.5.6 (2026-08-01)

### Features

- **Portable instructions:** pi-web now self-injects its backend-selection routing guidance via a gated `before_agent_start` hook (fires only when a `web_*` tool is active). This guidance previously lived in the global `~/.pi/agent/AGENTS.md`; moving it here makes it travel with the package and carry zero overhead when pi-web is absent. Per-tool `promptGuidelines` are unchanged.

## 0.5.5 (2026-07-30)

### Improvements

- Patch version bump for release sync and package documentation update.

## 0.5.4 (2026-07-24)

### Fixes

- Fixed best-effort error handling for `web_extract` and improved fallback reporting across search and extraction modules.

## 0.5.3 (2026-07-20)

### Features

- Support Pi 0.82.0 ESM extension loading.

## 0.4.0 (2026-07-10)

### Features

- Consolidated 14 backend-specific tools into 7 unified tools (`web_search`, `web_extract`, `web_map`, `web_crawl`, `web_screenshot`, `web_pdf`, `web_status`).
- Auto-selection and adaptive fallback between static (JSDOM), dynamic (Firecrawl), and full (Crawl4AI) backends.
