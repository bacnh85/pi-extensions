# ZCode attribution probe — results log

## Run 1 — in-window night, 2026-09-06 ~00:25 SGT (campaign window 23:00–09:00 SGT)

Account: GLM Coding Lite, version V1 (legacy, purchased 2025-11-08). Meter: quota/limit integer percentage (5h window).

| Leg | Traffic | Δ% (5h window) | Verdict |
|---|---|---|---|
| L1 key bare (self-calibration) | 8/8 ok, 463k in | +1 | billed normally at night |
| L2 key + ZCode identity headers | 8/8 ok, 462k in | +1 | **identical to L1 — headers do NOT change billing** |
| L3 JWT bare | blocked: JWT expired | — | pending ZCode refresh |
| L4 JWT + ZCode headers | blocked: JWT expired | — | pending ZCode refresh |
| L1cn CN key bare (bigmodel) | 8/8 ok, 462k in | 0 | separate quota pool or lag; inconclusive |
| L1r repeat | 8/8 ok | 0 | meter lags ~1 leg (deferred accounting) |

Notes:
- model-usage totalTokens is aggregated too slowly for short-term deltas (Δtok=0 despite 462k tokens) — dropped as a verdict signal.
- JWT is chat-invalid but read-valid: `agent/configs` accepted it while chat returned "token expired or incorrect". Quota reads with expired JWT return HTTP 200 + `success:false` bodies (pi-sub's documented 200-wrapped-401 shape).
- `GET zcode.z.ai/api/v1/agent/configs` (with stored JWT, HTTP 200):
  - `codingPlanSignature.enable: true` — the Ed25519+PoW client-signing gate is currently ON.
  - proxyEndpoint.mapping remaps `api.z.ai/api/anthropic/v1/messages` → `zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages` (bigmodel twin → `…/ultra/anthropic/...`). Genuine ZCode traffic goes through this signed ultra gateway, not api.z.ai directly.
- Installed ZCode app version: 3.10.2 (from running process), used for UA `ZCode/3.10.2`.

## Open questions
1. JWT legs (L3/L4/L5) — blocked until ZCode desktop refreshes `zcodejwttoken` (watcher: `scripts/jwt-wait-probe.mjs`, log `/tmp/zcode-jwt-watcher.log`).
2. Does the plain-key night rate include the campaign "2x quota for other agents" discount? → compare with an identical L1 during daytime (off-window). Night moved +1pt per ~463k input tokens; if day moves ~+2, the discount applies to Pi automatically.
3. Does a FRESH JWT + ZCode headers on the ultra-zai route get zero-quota treatment, and does the route require a valid Ed25519+PoW signature (gate is ON)? If yes, header/JWT emulation is insufficient — full signing implementation (port from TriDefender/zcode-api, MIT) or genuine ZCode client required.

## Addendum — 2026-09-06 ~00:45 SGT (user actively using ZCode desktop)

- User's ZCode desktop is in **API-key mode**: `builtin:zai-coding-plan.options.apiKey` (49 chars) is **byte-identical to Pi's `zai-anthropic` key**. Their active session consumes quota normally (meter 15% → 22% → 23% during their usage) — genuine ZCode + coding-plan API key = billed like any agent during the campaign window.
- `builtin:zai-start-plan` holds a 255-char JWT (zcode.z.ai route) — also **expired** (401 on both its own `/api/v1/zcode-plan/anthropic` route and api.z.ai).
- The stored `zcodejwttoken` (37h old) is expired for chat/billing but still accepted by read-only `zcode.z.ai/api/v1/agent/configs`.
- **Conclusion so far**: header emulation cannot work (L2 == L1), and the user's own ZCode-in-API-key-mode is billed normally. The campaign's "via ZCode" branch — if reachable at all for this V1-legacy plan — requires the OAuth-login mode (fresh JWT + signed ultra-zai route, `codingPlanSignature.enable=true`).
- Next: user switches ZCode to Coding-Plan **login** (OAuth) mode → fresh JWT minted → run `probe-zcode-attribution.mjs --jwt` for L3/L4; daytime L1 re-run for the off-window baseline.
- Meter trend while user used ZCode desktop (API-key mode): 15% -> 22% -> 23% -> 24% (00:30-00:50 SGT). Genuine ZCode usage billed normally throughout the campaign window.
- Final night snapshot: 24% at 00:44 SGT (stable while user idle on ZCode). Night legs complete; daytime L1 re-run pending for off-window baseline.
- Final meter value recorded: 28% at ~01:00 SGT 2026-09-06 (session closed; no further polling).

## Daytime run — 2026-09-06 ~09:45 SGT (off-window, Sunday; fresh 5h window at 1%)

| Leg | Result | vs night |
|---|---|---|
| L1 key bare | +1pt per 463k tok | identical to night (+1) → **no off-peak/campaign discount on the API-key path for this V1-legacy plan** |
| L2 key+zcode | 0pt (meter lag ~1 leg; run total L1+L2+L1cn+L1r = +2pt both runs) | day == night confirmed at run level |
| L3/L4 JWT | still 401 — stored JWT unchanged after user switched ZCode to login mode | JWT never refreshed |
| L1cn | +1pt (night's 0 was lag) | CN account bills too |

Post-login checks (user switched ZCode to Coding-Plan login mode 08:46):
- `builtin:zai-coding-plan` key re-read: STILL byte-identical to Pi's key — login mode provisions the same shared API key, no new credential minted.
- Storage scan (Local Storage leveldb, Cookies, rum-store, coding-plan partition): 2 JWT-shaped candidates — cand0 = the same stale start-plan JWT (401); cand1 = 1402-char token, 401 code 1004 Invalid API Key. **No live chat-valid JWT exists anywhere in ZCode 3.10.2.**

## Final verdict (Phase 1 complete)

ZCode 3.10.2 login mode authenticates with the same provisioned API key Pi uses; identity headers are billing-inert; no live JWT path exists. The ONLY remaining differentiator for a "via ZCode" attribution is the Ed25519+proof-of-work client signature on the ultra-zai route (gate ON). Emulation therefore requires porting client-signing V4 (reference: TriDefender/zcode-api, MIT) or running it as a sidecar — otherwise Pi's treatment is already identical to genuine ZCode's on this account (both billed ~1x day and night, no observable campaign discount).
