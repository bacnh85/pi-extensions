# Changelog

## 0.10.7 (2026-09-13)

### Fixed

- **Image download failures keep their reason**: failed URL downloads no
  longer discard the underlying error — the cause (DNS, SSRF guard, HTTP
  status) is exposed to callers/agents via `ApiImageResult.downloadErrors`
  (aligned with the raw `urls` array, which stays openable/parsable).
  User-visible rendering of the reasons in the tool's text output lands with
  the pending `index.ts` update.

### Added

- **404 retry for fresh generations**: CDNs like Z.ai's UCloud UFile serve
  404 for ~1–2s right after generation (edge propagation); downloads now
  retry with 1s/2s/3s backoff instead of wasting the generation.

## 0.10.5 (2026-09-13)

### Added

- **`GEMINI_WEB_SECURE_1PSIDTS` env** — the rotating `__Secure-1PSIDTS`
  session cookie, injected into the client jar pre-init. Google stopped
  serving SNlM0e/cookie rotations to plain clients; without it the session
  is partially authed (chat works, `accessToken` unresolved, sensitive
  surfaces refuse). With it: full auth (`accessToken` resolves).

## 0.10.4 (2026-09-13)

### Fixed

- **Truthful image extensions**: saved files are typed by magic bytes, not
  URL/file extension — Z.ai GLM-Image serves JPEG behind a `.png` URL, which
  previously produced mislabeled files and inline blocks.

## 0.10.3 (2026-09-13)

### Fixed

- **Redirect-aware SSRF guard**: image downloads now use `redirect: "manual"`
  and re-validate every hop with the private/loopback check — a gateway URL
  that 302s to an internal host (e.g. cloud metadata) can no longer bypass
  the guard via fetch's default redirect following. Public redirects still
  work (relative locations resolved per hop, max 3 hops).

## 0.10.2 (2026-09-13)

### Fixed

- `.gif` downloads inline as `image/gif` (was mislabeled `image/png`).
- **SSRF guard on gateway-supplied image URLs**: downloads to
  loopback/private/link-local hosts (e.g. cloud metadata 169.254.169.254)
  are refused before any request is made — the URL is surfaced instead.
- **25 MB download cap**: oversized image downloads are not written to disk;
  the URL is surfaced instead.
- pi-hub catalog/README description updated to match 0.10.x features.

## 0.10.1 (2026-09-13)

### Added

- **Gemini image-refusal session skip** — after 2 consecutive "replied with
  text but no images" refusals (observed on accounts where the chat path
  refuses image generation), `provider: auto` skips gemini for the rest of
  the session and goes straight to `zai`/`custom`; pinned
  `provider=gemini` always retries, and any gemini success resets the
  counter. Session-scoped (resets with pi).

## 0.10.0 (2026-09-13)

### Added

- **`web_chat` tool** — one-off chat completion against any OpenAI-compatible
  gateway (`WEB_CHAT_API_BASE_URL` + optional `WEB_CHAT_API_KEY`): a ChatGPT
  web bridge, official OpenAI (`https://api.openai.com/v1`), or any web2api
  gateway. Non-streaming `POST /chat/completions` with optional `model`/
  `system`; timeout capped at 300 s. Error mapping: 401/403 key hint,
  429 quota, 502 → "empty account pool" hint, 5xx server error.
- `web_status` now reports `webChat` (configured/baseUrl/keyFound/source).

Supersedes the removed `pi-chatgpt-web` package (free web-chat-only models):
point `WEB_CHAT_API_BASE_URL` at the same gateway to keep using it.

## 0.9.2 (2026-09-13)

### Fixed

Review hardening of the `web_image` fallback chain (3 review rounds):

- **Cancellation semantics**: an aborted call now surfaces `AbortError`
  immediately — before any provider client construction or fetch — instead of
  walking the chain and reporting "all providers failed". An abort landing
  mid-generation normalizes to `AbortError` with the in-flight provider error
  preserved as `cause`; foreign abort-named errors from upstreams are recorded
  as provider notes and the chain continues.
- **`n` transparency**: when the gemini web tier returns fewer images than the
  requested `n`, the result states it explicitly (`n` applies to the
  `zai`/`custom` API providers; the gemini web tier returns its own count).
  `out_dir` now resolves against the session cwd, not the process cwd.

## 0.9.1 (2026-09-13)

### Fixed

- **`zai` default model is `glm-image`** (live-verified against
  `api.z.ai/api/paas/v4/images/generations` — the endpoint rejects
  `cogview-4`/`cogview-3-flash` with "Unknown Model"; GLM-Image returns
  URL results).
- **Failed image downloads no longer waste the generation** — some upstreams
  return URL-only results and the CDN can be unreachable from the local
  network (e.g. `mfile.z.ai` DNS-sinkholed). The tool now reports
  "Not saved (image host unreachable…)" with the URL instead of failing the
  provider; inline image blocks are still attached for saved files.

## 0.9.0 (2026-09-13)

### Added

- **`web_image` tool** — image generation from text via free upstream
  providers, all direct-to-upstream (no self-host services), with automatic
  fallback: `gemini` (gemini.google.com web tier via `gemini-reverse`, guest
  or cookie auth) → `zai` (official `api.z.ai` GLM-Image via `ZAI_API_KEY`)
  → `custom` (any OpenAI-compatible `/images/generations` endpoint via
  `WEB_IMAGE_API_BASE_URL`). `provider: "auto"` walks the chain and the
  result reports every fallback attempt.
- Results are saved as files (`out_dir`, default fresh temp dir) and returned
  as **inline image blocks** so multimodal models see their own output;
  `model`/`n` (1–4) parameters per call.
- **Soft ToS guardrails** — per-provider `WEB_IMAGE_MIN_INTERVAL_MS`
  (default 5000) and a `WEB_IMAGE_DAILY_CAP` (default 20/day) on the Gemini
  web tier; successes-only counting, UTC-day reset, usage surfaced in
  `web_status.imageProviders.rate`.
- `web_status` now reports `imageProviders` (gemini/zai/custom config + rate
  snapshot).
- Smoke script: `image` and `zai` modes (prints saved paths + PNG magic-byte
  check); ask/research modes now print **full answers and source URLs**
  (previously sliced to a 200/400-char preview).

## 0.8.0 (2026-09-13)

### Added

- **`web_research` tool** — AI-synthesized web research via Gemini's web tier
  (gemini.google.com), cookie-authed with `__Secure-1PSID`.
  `mode: "ask"` returns a quick grounded answer with extracted source links
  (works in guest mode without any cookie, Flash-only);
  `mode: "research"` runs Gemini **Deep Research** — an autonomous agent that
  browses the web for minutes and returns a comprehensive report (requires the
  cookie and a Gemini Advanced subscription; default timeout 10 min, cap 30).
- New `lib/gemini.ts` wrapper over the `gemini-reverse` npm package (lazy
  dynamic import, injectable client for tests, one AuthError retry that
  re-absorbs rotated Set-Cookies). Sources are extracted from markdown links
  in the answer/report text (the web protocol exposes no structured citations).
- `web_status` now reports `geminiWeb` (configured/cookieSource/proxy).
- Env config: `GEMINI_WEB_SECURE_1PSID` (required for authed/research mode),
  optional `GEMINI_WEB_PROXY` (escape hatch if Google blocks the IP).
- **Header-cap fix (authed mode)** — Google ships ~25 KB of response headers on
  Gemini pages (giant `content-security-policy`), over Node's default 16 KB
  parser cap; the wrapper injects a per-request `maxHeaderSize` for
  gemini.google.com hosts only (lazy, no global flag needed).

## 0.7.1 (2026-09-12)

### Fixed

- `before_agent_start` routing guidance now falls back to `pi.getActiveTools()`
  when the host omits `systemPromptOptions` (mirrors pi-fff), so guidance no
  longer silently skips injection.
- README: corrected default backend URLs to `127.0.0.1` (matching code defaults
  in `lib/config.ts`), removed the nonexistent `npm run test:unit` script
  reference, documented the `web_search` `timeout_ms` parameter.

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
## 0.10.6

Docs correction: Deep Research is **not** Gemini-Advanced-gated. Live
verification (2026-09-13, free-tier account): Deep Research plan creation
succeeds via a browser-impersonating client, while this package's Node
transport is refused with 1184/FEATURE_NOT_AVAILABLE on the same fresh
session. The 1184 error is a client-transport artifact; README,
`web_research` descriptions, and troubleshooting updated accordingly.
