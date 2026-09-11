# Changelog

## 0.7.0 (2026-09-11)

### Added

- **Local capture engine** — `web_screenshot` and `web_pdf` now capture
  `localhost`/LAN/`file://` URLs via the locally installed Chrome/Chromium
  (headless CLI, zero dependencies). The Crawl4AI daemon's browser runs on the
  daemon host and SSRF-blocks private addresses, so local dev servers were
  uncapturable before. Routing is automatic (`engine="auto"` default):
  private URLs → local Chrome, public URLs → daemon, and a daemon SSRF-block
  on an otherwise-public URL falls back to local Chrome automatically.
  `engine="local"`/`"daemon"` forces one. New `web_screenshot` params:
  `width` (1280), `height` (800), `full_page` (tall 8000px window — the
  Chrome CLI has no true full-page flag). Binary discovery: `CHROME_PATH` env
  → standard per-OS paths (Edge as Windows fallback). Captures run in an
  isolated temp profile with a 30s timeout; `wait_for` maps to
  `--virtual-time-budget`. Chrome versions that write the capture but never
  exit (fresh `--user-data-dir` on macOS) are handled by polling for a
  size-stable output file instead of requiring a clean exit. Review-hardened:
  capture URLs are scheme-validated (http/https/file) before spawn so
  switch-like strings can't be injected as Chrome flags; IPv6 loopback/ULA/
  link-local (`[::1]`, `fc00::/7`, `fe80::/10`) route to local Chrome (Node
  `URL.hostname` keeps brackets); daemon `details` payloads are preserved
  (mime/artifact/full result) alongside the new `engine` key; timeout is
  always a failure (a complete capture is caught by the stability poll first).
  `web_status` reports the discovered local Chrome path.
- New `extensions/lib/chrome.ts` (engine + `isLocalUrl`/`resolveEngine`/
  `isSsrfBlocked` helpers) with unit tests in `test/unit/chrome.test.ts`;
  live-verified against a local `http.server` (PNG magic, PDF magic, inline
  image block, tmp cleanup, no orphan processes).

## 0.6.2 (2026-09-06)

### Changed

- `web_screenshot` now returns the PNG **inline as an image block**
  (`ImageContent`) alongside the text summary, so multimodal models (GLM-5.3,
  Claude, Gemini) actually see the screenshot instead of a base64 char
  count. The "Data: base64 PNG (N chars)" line is gone; artifact/MIME/size
  summary unchanged. Inspired by zcode-plugins video2code's vision-in-the-loop.
  Regression-tested in `test/unit/screenshot.test.ts` (fetch stubbed — no
  daemon needed): image block present + base64-text line absent; text-only
  fallback when the daemon returns no screenshot.

  Daemon `success:false` responses (HTTP 200) now surface `error_message` as
  a tool error instead of returning a silently empty screenshot result.

## 0.6.1 (2026-08-30)

### Changed

- Trimmed static prompt overhead ~385 tokens/turn: compressed the injected
  `Web Tool Routing` guidance block (1,247 -> 281 chars, same routing table
  + backend rules), cut all 7 tools' promptGuidelines to <=2 unique lines,
  and shortened web_crawl/web_screenshot schema descriptions. One
  hook.test.ts assertion updated to the compressed phrasing. No tool,
  parameter, or default changed.

### Changed (2026-08-19)

- `web_extract` agy backend default model updated to `gemini-3.7-flash-medium`
  — the current Flash generation in agy 1.1.x (3.6 is still served, this just
  follows the latest).

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
