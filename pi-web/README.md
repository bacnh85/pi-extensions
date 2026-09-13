# @bacnh85/pi-web

Pi extension for **unified web search, content extraction, site crawling, page capture, and Gemini web-tier research**.

Auto-selects the best backend from SearXNG (self-hosted), Brave Search, Firecrawl, Crawl4AI, and agy (Gemini/Claude, when installed) — so agents don't have to know which backend to use. Search selection is adaptive: broad discovery prefers self-hosted SearXNG, while precision-sensitive searches and inline content prefer Brave. `web_research` adds AI-synthesized research with citations via your gemini.google.com session.

## Install

```bash
pi install npm:@bacnh85/pi-web
```

## Configuration

Environment lookup order:

1. Process environment
2. Current working directory `.env.local`
3. Current working directory `.env`
4. Pi global config `~/.pi/agent/.env.local`
5. Pi global config `~/.pi/agent/.env`

Variables:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BRAVE_API_KEY` | No (1) | — | Brave Search API key |
| `SEARXNG_BASE_URL` | No | `http://127.0.0.1:8888` | Self-hosted SearXNG |
| `FIRECRAWL_API_URL` | No | `https://api.firecrawl.dev/v2` | Self-hosted or hosted |
| `FIRECRAWL_API_KEY` | No (2) | — | Required for hosted Firecrawl |
| `CRAWL4AI_API_URL` | No | `http://127.0.0.1:11235` | Self-hosted Crawl4AI |
| `CRAWL4AI_API_TOKEN` | No (3) | — | Required if Crawl4AI auth enabled |
| `GEMINI_WEB_SECURE_1PSID` | No (4) | — | `__Secure-1PSID` cookie from gemini.google.com — enables authed `web_research` (Deep Research) |
| `GEMINI_WEB_PROXY` | No | — | Proxy URL for Gemini web calls (escape hatch if Google blocks the IP) |

> (1) At least one search backend (SearXNG, Brave, or Firecrawl) must be configured for `web_search`.
> (2) Required for hosted Firecrawl; optional for self-hosted instances without auth.
> (3) Required for Crawl4AI v0.9+ default config.
> (4) Without it `web_research mode=ask` still works in guest mode (Flash-only); `mode=research` errors with setup steps.

Secrets are never printed; `web_status` reports only presence/source.

### Always-on routing guidance

When any `web_*` tool is active, pi-web injects a condensed backend-selection protocol (SearXNG → Brave → Firecrawl ordering, Firecrawl precision/scrape caveats, source-citation rule) into the system prompt via a `before_agent_start` hook. This travels with the package — no edits to `~/.pi/agent/AGENTS.md` are required — and carries zero overhead when pi-web is not loaded.

## Tools

### `web_search` — Unified search

Searches the web. Auto-selects backends adaptively: SearXNG for broad self-hosted discovery, Brave for precision-sensitive queries and `include_content`, Firecrawl as last resort.

```
web_search query="ansible podman quadlet" count=5
web_search query="ansible documentation" backend=brave count=10
web_search query="latest python release" engines="google,github"
web_search query="riven media" include_content=true
```

Parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | — | Search query |
| `count` | number | 5 | Number of results (max 20) |
| `freshness` | string | — | Time filter: `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD` |
| `country` | string | `US` | Two-letter country code |
| `backend` | string | `auto` | Force backend: `auto`, `searxng`, `brave`, `firecrawl` |
| `engines` | string | — | SearXNG engine override, e.g. `google,github` |
| `include_content` | boolean | false | Fetch page content alongside results |
| `content_chars` | number | 5000 | Max content chars per result |
| `timeout_ms` | number | per-backend | Request timeout in ms (SearXNG/static 15000, Firecrawl/Crawl4AI 60000) |

**Auto-selection behavior:**

1. **SearXNG** — first for broad/general discovery, especially when `engines` is supplied.
2. **Brave** — first for precision-sensitive queries (`site:`, quoted phrases, docs/API/source lookups, short proper-name queries) and whenever `include_content` is true. Requires `BRAVE_API_KEY`.
3. **Firecrawl Search** — last resort. ⚠️ Poor semantic accuracy on domain-specific/ambiguous queries (e.g., "Riven" returns League of Legends results). Prefer SearXNG or Brave for precision.

Tool output includes search diagnostics showing attempted backends and the selected backend.

Use `backend` parameter to force a specific backend when needed.

### `web_extract` — Unified content extraction

Extracts readable content from a URL. Auto-selects backend: static (JSDOM) → dynamic (Firecrawl) → full (Crawl4AI) → agy (model-backed), with extraction diagnostics showing fallback attempts.

```
web_extract url="https://docs.ansible.com/..."
web_extract url="https://riven.tv/" mode=static
web_extract url="https://example.com" mode=dynamic prompt="Extract pricing plans"
web_extract url="https://blocked.example.com" mode=agy
```

Parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | URL to extract |
| `mode` | string | `auto` | `auto`, `static`, `dynamic`, `full`, or `agy` |
| `prompt` | string | — | Prompt for JSON extraction (dynamic/agy modes) |
| `schema` | any | — | JSON schema for structured extraction (dynamic/agy modes) |
| `content_chars` | number | 20000 | Max content chars |
| `wait_for` | number | — | Milliseconds to wait for Firecrawl dynamic rendering. Crawl4AI `/md` full mode may ignore this. |
| `mobile` | boolean | false | Emulate mobile viewport (dynamic mode) |

**Mode behavior:**

| Mode | Backend | Best for | API key needed |
|---|---|---|---|
| `static` | JSDOM+Readability | Simple static pages, blog posts, docs | No |
| `dynamic` | Firecrawl Scrape | JS-rendered pages, dynamic content | Maybe |
| `full` | Crawl4AI | JS-heavy SPA, complex rendering | Maybe |
| `agy` | agy (Gemini/Claude) | Bot-protected / anti-AI-scraping pages | agy CLI installed |
| `auto` (default) | static → dynamic → full → agy | Unknown page type | Maybe |

In `auto` mode, fallbacks are noted in the output (e.g., `[Extraction fell back to Firecrawl Scrape (dynamic mode)]`). If `static` extraction fails, the tool gracefully escalates to heavier backends.

> ⚠️ **Note on Firecrawl Scrape**: Fails on bot-protected sites (Ansible docs, many CDN-backed doc sites). Falls back to `full` mode (Crawl4AI) in `auto` mode, and to `agy` mode as a last resort.

> **`agy` mode (optional)**: Uses the [Antigravity CLI](https://antigravity.google/) with Gemini/Claude — its native `read_url` browser tool can fetch pages that block Firecrawl/Crawl4AI. Install with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, authenticate once with `agy`, then `auto` mode falls back to it automatically. If agy is not installed, `auto` mode skips it silently; `web_status` reports `agy.installed`.

### `web_map` — Site URL discovery

Discovers URLs from a site using Firecrawl Map. Best on base domains; may return fewer results on sub-paths.

```
web_map url="https://riven.tv"
web_map url="https://docs.example.com" sitemap=only
```

Parameters: `url`, `limit` (default 100), `include_subdomains`, `search`, `sitemap`, `use_index`, `ignore_cache`.

### `web_crawl` — Site crawl

Crawls pages from a site. Two modes:

- **`light`** (default): Firecrawl Crawl — conservative, docs-focused, single URL.
- **`full`**: Crawl4AI Crawl — headless browser, rendered data, media, links, up to 100 URLs.

```
web_crawl url="https://docs.example.com" limit=10          # Firecrawl light mode
web_crawl urls=["https://a.com","https://b.com"] mode=full  # Crawl4AI full mode
web_crawl url="https://example.com" mode=light poll=true    # Poll for completion
```

### `web_screenshot` — Page screenshot

Captures a full-page PNG screenshot using the Crawl4AI daemon, or **local headless Chrome for localhost/LAN/file URLs** (auto-detected; see [Local capture](#local-capture)). Returns the PNG inline as an image block (multimodal models see it); text summary includes engine/MIME/size.

```
web_screenshot url="https://example.com"
web_screenshot url="https://example.com" wait_for=5 wait_for_images=true
web_screenshot url="http://localhost:3000"           # local Chrome, auto-detected
web_screenshot url="http://localhost:3000" full_page=true width=1280
web_screenshot url="https://example.com" engine="daemon"  # force the daemon
```

Local-engine params: `width` (default 1280), `height` (default 800), `full_page` (captures a tall 8000px window — the Chrome CLI has no true full-page flag).

### `web_pdf` — Page PDF

Generates a PDF document using the Crawl4AI daemon, or **local headless Chrome** for localhost/LAN/file URLs (auto-detected). Returns base64-encoded PDF.

```
web_pdf url="https://example.com/article"
web_pdf url="http://localhost:3000"   # local Chrome, auto-detected
```

### Local capture

The Crawl4AI daemon's browser runs on the daemon host — it cannot reach (and SSRF-blocks) your `localhost`. pi-web therefore routes private URLs to a **locally installed Chrome/Chromium** in headless mode:

| URL | Engine |
|-----|--------|
| `localhost`, `127.0.0.1`, LAN IPs (10/8, 172.16/12, 192.168/16, 169.254/16), `file://` | local Chrome |
| public URLs | Crawl4AI daemon |
| daemon SSRF-blocks a URL | automatic local-Chrome retry |

Override with `engine="local"` / `engine="daemon"`. Binary discovery: `CHROME_PATH` env, then standard Chrome/Chromium paths per OS (Edge as a Windows fallback). Captures use an isolated temp profile, a 30s timeout, and `--virtual-time-budget` for `wait_for`.

### `web_status` — Provider status

Shows all provider configuration status and Crawl4AI server health.

```
web_status
```

Typical output:

```json
{
  "brave": { "apiKeyFound": true, "apiKeySource": "process.env" },
  "searxng": { "baseUrl": "http://127.0.0.1:8888", ... },
  "firecrawl": { "baseUrl": "http://127.0.0.1:3002/v2", ... },
  "crawl4ai": {
    "baseUrl": "http://127.0.0.1:11235",
    ...
    "health": { "status": "healthy", "version": "0.5.0", ... }
  },
  "agy": { "installed": true },
  "geminiWeb": { "configured": true, "cookieSource": "process.env", "proxy": false },
  "localChrome": { "path": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
}
```

### `web_research` — Gemini web-tier research

AI-synthesized research through your gemini.google.com session (powered by the
[`gemini-reverse`](https://github.com/rynn-k/Gemini-Reverse) client, lazy-loaded).

```
web_research(query="compare the top 3 cloud providers' AI offerings", mode="research", timeout_ms=600000)
```

- **`mode: "ask"`** (default) — quick grounded answer (Gemini auto-grounds with
  Google Search). Works **without any cookie** in guest mode (Flash-only).
  Sent as a temporary chat so your Gemini history stays clean.
- **`mode: "research"`** — full Gemini **Deep Research**: plan → autonomous web
  browsing (minutes) → cited report. Requires the cookie **and a Gemini
  Advanced subscription** on the account. Default timeout 600 s, cap 1 800 000.

Both modes return the text plus **Sources** — URLs extracted from the
answer/report markdown (the web protocol exposes no structured citations field).

Setup (authed mode):

1. Sign in at [gemini.google.com](https://gemini.google.com/).
2. `F12` → **Application** → **Cookies** → `https://gemini.google.com`.
3. Copy the `__Secure-1PSID` value into `~/.pi/agent/.env.local`:

   ```bash
   GEMINI_WEB_SECURE_1PSID=your-cookie-value
   # optional, if Google blocks your IP:
   # GEMINI_WEB_PROXY=http://host:port
   ```
4. Restart pi; `web_status` shows `geminiWeb.configured: true`.

Live verification script (also proves the header-cap patch end-to-end — an
authed failure would surface `HPE_HEADER_OVERFLOW`):

```bash
npx tsx extensions/scripts/gemini-smoke.ts "test query"            # ask (authed or guest)
npx tsx extensions/scripts/gemini-smoke.ts "topic" research        # Deep Research
```

⚠️ **Unofficial, at your own risk.** Cookie auth uses your real Google session
against gemini.google.com's internal web API and may not comply with Google's
ToS; the protocol can break when Google changes it. `ask` mode errors map to
actionable steps (expired cookie → re-copy; IP block → set `GEMINI_WEB_PROXY`).

Troubleshooting:

- *"cookie expired or invalid"* — re-copy `__Secure-1PSID` (it rotates).
- *"temporarily blocked this IP"* — set `GEMINI_WEB_PROXY`.
- *research mode: "Unknown API error: 1184"* — on this account Deep Research
  was rejected; usually means no Gemini Advanced subscription on the account
  (Deep Research is Advanced-only), or Google changed the protocol. `ask`
  mode is unaffected.

## Library structure

| Module | Contents |
|--------|----------|
| `lib/config.ts` | Environment loading, config helpers for all providers |
| `lib/format.ts` | Text sanitization, truncation, crawl/scrape result formatting |
| `lib/content.ts` | Readable content extraction (JSDOM + Readability + Turndown) |
| `lib/retry.ts` | Retry with exponential backoff for transient HTTP failures |
| `lib/brave.ts` | Brave Search API fetch client (internal) |
| `lib/searxng.ts` | SearXNG metasearch fetch client (internal) |
| `lib/firecrawl.ts` | Firecrawl API fetch client with v2→v1 fallback (internal) |
| `lib/crawl4ai.ts` | Crawl4AI Docker API fetch client (internal) |
| `lib/agy.ts` | agy (Antigravity CLI) spawn helper — `read_url` extraction via Gemini/Claude |
| `lib/search.ts` | Unified search orchestrator — probes backends, fallback chain |
| `lib/extract.ts` | Unified extraction orchestrator — mode-based backend selection |

## Migration from 0.3.x

v0.4 replaces the 14 individual backend-specific tools with 7 unified tools:

| v0.3 tool | v0.4 replacement |
|---|---|
| `brave_search` | `web_search` with `backend: "brave"` |
| `searxng_search` | `web_search` with `backend: "searxng"` |
| `firecrawl_search` | `web_search` with `backend: "firecrawl"` |
| `web_content` | `web_extract` with `mode: "static"` |
| `firecrawl_scrape` | `web_extract` with `mode: "dynamic"` |
| `crawl4ai_scrape` | `web_extract` with `mode: "full"` |
| `firecrawl_map` | `web_map` (same behavior) |
| `firecrawl_crawl` | `web_crawl` with `mode: "light"` |
| `crawl4ai_crawl` | `web_crawl` with `mode: "full"` |
| `crawl4ai_stream` | (removed — use `web_crawl` with `mode: "full"`) |
| `crawl4ai_screenshot` | `web_screenshot` (same behavior) |
| `crawl4ai_pdf` | `web_pdf` (same behavior) |
| `crawl4ai_status` | Merged into `web_status` |
| `web_status` | `web_status` (enhanced with Crawl4AI health) |

All v0.3 tool names were removed in v0.4. Update any agent instructions or skills that reference the old names.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Development

```bash
# Run all tests
npm test
```
