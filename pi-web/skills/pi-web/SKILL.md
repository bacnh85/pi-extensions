---
name: pi-web
description: Web search, content extraction, site crawling, and page capture via the pi-web extension. Use when the user needs current web search results, documentation lookup, factual research, source discovery, URL-to-markdown extraction, JSON extraction from websites, site URL discovery, site crawling, or page screenshots/PDFs. Use when the user mentions searching the web, finding docs, looking something up, researching, scraping/extracting content from a URL, or capturing a page.
---

# pi-web — Unified Web Tools

Use the **7 unified tools** from the `pi-web` extension for all web-related tasks. These tools automatically select the best backend from SearXNG, Brave Search, Firecrawl, and Crawl4AI — you don't need to know which backend to use. Search selection is adaptive: broad discovery prefers self-hosted SearXNG, while precision-sensitive queries and inline content prefer Brave.

## Quick Reference

| Tool | Purpose | Auto-selection |
|---|---|---|
| `web_search` | Search the web for sources, docs, facts | SearXNG → Brave → Firecrawl |
| `web_extract` | Extract readable content from a URL | Static (JSDOM) → Dynamic (Firecrawl) → Full (Crawl4AI) |
| `web_map` | Discover URLs from a site | Firecrawl Map (only option) |
| `web_crawl` | Crawl multiple pages from a site | Light (Firecrawl) or Full (Crawl4AI) |
| `web_screenshot` | Capture page screenshot as PNG | Crawl4AI (only option) |
| `web_pdf` | Generate page PDF | Crawl4AI (only option) |
| `web_status` | Check provider configuration and health | — |

## Decision Tree

```
What do you need?
│
├── Search results (URLs, snippets, docs lookup)
│   → web_search
│     ├─ default: adaptive auto-selects SearXNG or Brave, then Firecrawl
│     ├─ precision/inline content: auto prefers Brave, or explicit backend=brave
│     └─ SearXNG engine tuning: engines=google,github
│
├── Content from a known URL (markdown, structured data)
│   → web_extract
│     ├─ static page (blog, docs): mode=static (fastest, no API key)
│     ├─ dynamic page (JS-rendered): mode=dynamic
│     ├─ JS-heavy SPA: mode=full
│     └─ auto (default): tries static > dynamic > full
│
├── Site URL discovery (find pages on a site)
│   → web_map
│     └─ sitemap=only for sitemap-only discovery
│
├── Crawl multiple pages from a site
│   → web_crawl
│     ├─ docs/docs section: mode=light (default, Firecrawl)
│     └─ rendered data with media/links: mode=full (Crawl4AI)
│
├── Visual snapshot of a page
│   → web_screenshot
│
├── Printable/archivable PDF of a page
│   → web_pdf
│
└── Check what web tools are configured
    → web_status
```

## Auto-selection Details

### `web_search` adaptive backend order

1. **SearXNG** (self-hosted, free) — first for broad/general discovery.
   - Use `engines` parameter to tune: `engines: "google,github"` for technical queries.
   - If auto-selection returns poor results, try `backend: "brave"` for a different search index.
2. **Brave Search** (hosted, requires API key) — first for precision-sensitive queries and inline content.
   - Auto mode prefers Brave for `include_content`, `site:` searches, quoted phrases, docs/API/source lookups, short proper-name queries, and domain-specific/ambiguous queries.
   - Supports `include_content` for inline page content.
   - Handles page-content fetch failures gracefully by keeping search results and adding per-result notes.
3. **Firecrawl Search** — last resort.
   - ⚠️ **Poor semantic accuracy** on domain-specific/ambiguous queries. E.g., "Riven" returns League of Legends champion build guide instead of the media-automation tool. Prefer SearXNG or Brave for precision.
   - Acceptable for general technical queries.

### `web_extract` mode order

1. **static** (JSDOM+Readability) — no API key needed, works on simple static sites, blogs, and doc pages. Fastest option.
2. **dynamic** (Firecrawl Scrape) — handles JS-rendered pages and dynamic content.
   - ❌ Fails on bot-protected sites (Ansible docs, many CDN-backed doc sites). Falls through Crawl4AI in `auto` mode.
   - ✅ Supported: prompt-based JSON extraction, schema-based structured extraction.
3. **full** (Crawl4AI headless browser) — handles all content types. **Resource-intensive** (launches a full headless browser). Use only when static and dynamic modes fail, or when explicitly needed.

## Fallback Strategy

If one tool fails, try the next option in the chain:

- **Search issues**: `web_search` auto-fallbacks and reports backend diagnostics. If all backends fail, configure at least one via env vars (check `web_status`).
- **Extraction issues**: `web_extract` auto-fallbacks in `auto` mode. If all modes fail:
  1. Try `web_screenshot` for a visual snapshot — may work when extraction is blocked.
  2. The page may require interactive login, CAPTCHA, or be a non-HTML resource.
- **Tool not found**: Ensure `pi-web` extension is installed (`pi install ./extensions/pi-web`).

## Cross-tool Decision Guide

| If you need... | Use this | Instead of... |
|---|---|---|
| A few specific pages from a site | `web_map` + `web_extract` on each URL | `web_crawl` (heavier than needed) |
| Content from a JS-heavy page that fails in `auto` mode | `web_extract` with `mode: "full"` | Retrying `auto` mode repeatedly |
| A visual of a bot-protected page | `web_screenshot` | Retrying `web_extract` with all modes |
| Content alongside search results | `web_search` with `include_content: true` (auto prefers Brave) or `backend: "brave"` | Search snippets alone |
| Printable/archivable page | `web_pdf` | Taking a screenshot and converting |
| All URLs on a docs site | `web_map` with `sitemap: "only"` | Crawling the entire site |

## Important Notes

- **Always cite source URLs** when using web content in answers.
- `web_status` shows which backends are configured without printing secrets. For Firecrawl, `apiKeyFound: false` is normal for self-hosted instances without auth — check the `ready` field to see if Firecrawl is actually usable.
- The `backend` and `mode` parameters give explicit control when auto-selection is not desired.
- Backend-specific config (API keys, URLs) comes from environment variables, not tool parameters. Use `web_status` to verify configuration.
