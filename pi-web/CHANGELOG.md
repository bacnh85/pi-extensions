# Changelog

## 0.17.2 (2026-09-20)

### Fixed

- **`web_crawl` light-mode poll loop honors `timeout_ms`** — previously the
  loop polled up to 60×2s regardless of the caller's timeout. The deadline is
  clamped 1s–600s (same as `web_interact` step budgets); when it passes, the
  loop stops and returns the current incomplete crawl state with an explicit
  note. Behavior is unchanged when `timeout_ms` is absent (iteration cap only).

## 0.17.1 (2026-09-19)

### Fixed

- **`web_interact` press accepts `"Space"`** as an alias for `" "` (the docs
  already advertised the named key; `KEY_MAP` now maps it to the identical
  keyDown/keyUp events — regression-tested).
- **SKILL.md routing honesty:** the `web_image` auto-fallback chain now lists
  the `chatgpt` tier (gemini → chatgpt → zai → custom); the `web_chat` row
  states ChatGPT web is the default provider when `CHATGPT_WEB_AUTH_KEY`/
  codex login is configured (gateway is the fallback); the `web_research`
  decision-tree branch no longer calls `mode=research` "blocked" — live
  sessions run the full plan/confirm/report cycle, degraded/stale sessions
  return an honest partial result (plan + transcript + note).
- README environment-variable footnotes renumbered to sequential order
  (were 1,2,3,4,6,5).

## 0.17.0 (2026-09-18)

### Added

- **`web_interact` native dialog handling** — a click that opens a native
  `confirm()`/`alert()`/`prompt()`/`beforeunload` can no longer hang the tool
  call (previously the renderer blocked forever, the next step never
  resolved, and the run died with "Chrome DevTools connection closed"):
  `Page.javascriptDialogOpening` is answered automatically — **dismissed by
  default** so destructive actions stay blocked — and reported on the step
  result and at run level, e.g. `confirm("Delete?") → dismissed`.
  The same engine powers the local paths of `web_screenshot`/`web_pdf`, so a
  page that opens a dialog on load can no longer wedge those either.
- **`dialog` step** — `{"dialog": "accept" | "dismiss"}` arms the answer for
  the NEXT dialog once (consumed by the handler or expired at the following
  step boundary — an unconsumed arm can never silently approve an unrelated
  dialog steps later), so flows that must
  accept a confirm are a single step instead of a `window.confirm` override
  hack.
- **Per-step timeout** — the previously-declared-but-unused `timeout_ms`
  control param now budgets each step (default 60s, clamped 1s–600s); a
  wedged step fails with the reason ("timed out — page likely blocked
  (native dialog?) …") instead of hanging until the websocket dies. The
  post-loop overflow probe and auto-final screenshot are bounded by the same
  budget, so the whole call is guaranteed to resolve.

Found in a live QA session (DTDS-CRM delete-verification): a native
`confirm()` on the delete button hung `web_interact` with no way to
interrupt. Verified against real Chrome: default branch leaves the record
intact with the dialog reported; the armed-accept branch completes the
delete.

## 0.16.1 (2026-09-17)

### Fixed

- Skill frontmatter `description` exceeded pi's 1024-character limit
  (1107), triggering a `[Skill conflicts]` load error on every session.
  Trimmed to 949 by dropping provider-internal parentheticals — all
  trigger phrases intact.

## 0.16.0 (2026-09-17)

### Added

- **`web_interact` tool** — drive a real headless Chrome session through a
  CDP-over-native-WebSocket engine (`lib/cdp.ts`, zero deps, Node ≥22): one
  call = one browser lifecycle. Steps run in order and stop at the first
  failure with the reason: `click` (trusted CDP mouse events — user
  activation works, so `execCommand('copy')` and login flows behave for real),
  `type`, `press` (Enter/Tab/arrows/…), `evaluate` (value correctly
  double-unwrapped, `awaitPromise` on), `wait_for` (selector or ms),
  `screenshot`. Returns per-step results, a final inline PNG, and a
  `scrollWidth`/`innerWidth` probe. Options: `viewport` (honest
  device-metrics emulation — immune to the headless 500px window clamp),
  `reduced_motion` (staggered load reveals screenshot as blank sections
  otherwise), `grant` (browser permissions, e.g. clipboard).
- `web_screenshot`/`web_pdf` `reduced_motion` parameter →
  `--force-prefers-reduced-motion` on the local CLI engine.
- **Honest sub-500px captures**: `web_screenshot` local engine with
  `width < 500` automatically routes through CDP device emulation and reports
  `Viewport: WxH (device-emulated)` + the probe line (`scrollWidth > width`
  ⇒ `— CONTENT OVERFLOWS`) instead of rendering 500px and cropping.

### Fixed

- Local capture cleanup no longer throws intermittent `ENOTEMPTY`: Chrome is
  SIGKILLed the moment the PNG is size-stable but may still write profile
  files; temp-dir removal now retries briefly and never fails the capture
  over leftover temp state.
- **`web_interact` `grant` permissions are aliased**: Chrome CDP rejects
  `"clipboard-read"`/`"clipboard-write"` (`Unknown permission type`); the
  friendly names map to `clipboardReadWrite`/`clipboardSanitizedWrite` (found
  by an independent herdr UX-loop test session).
- **Hidden-element clicks fail loudly**: a zero-size rect (display:none)
  would have dispatched a trusted click at the viewport origin (0,0) —
  hitting whatever interactive element lives there with user activation while
  reporting ok. Now errors `element not visible (zero size)`.
- **The scrollWidth probe can no longer discard results**: a failed probe
  evaluate (ws closed after abort, target crash) used to reject the whole
  call; the probe is advisory and yields `{}` while outcomes/screenshots are
  returned.
- **`web_screenshot` honors `full_page` on the emulated (<500px) path** —
  previously silently returned an 844px viewport; now captures the tall
  8000px window like the CLI path.
- **No false "step navigated" warning**: the in-step navigation tracker is
  attached after the initial page load (real Chrome fires frameNavigated for
  the initial main-frame navigation too, which flagged every call) and only
  records main-frame navigations — subframe/iframe events carry a `parentId`
  and are ignored.
- **`type` step errors distinguish missing vs non-focusable**: a plain `div`
  or disabled input now reports `element is not focusable` instead of the
  misleading `no element matches`.
- **Digit `press` keys emit `Digit1`-style codes** (were `Key1`), so page
  handlers gating on `e.code` fire; `{screenshot: false}` steps are treated
  as a declined capture instead of capturing and suppressing the auto-final.

### Changed

- **`web_interact` step schema flattened** (one optional action field per
  step object, `wait_ms` split from `wait_for`): Z.ai's anthropic-compatible
  endpoint rejects anyOf nested inside anyOf with 400/1210 — the nested-union
  shape made every session request fail on that provider. `wait_ms` is mapped
  back onto `wait_for` at runtime.
- Mid-step navigations (form submit via Enter) are detected and annotated —
  `⚠ A step navigated the page to <url>` in the result text and `navigatedTo`
  in details, so post-navigation evaluates are never mistaken for "the
  handler did nothing".

### Notes

- `Target.createTarget` goes over the websocket, never the `/json/new` HTTP
  endpoint (whose method flipped to PUT in Chrome 111+).
- Requires Node ≥22 for the native `WebSocket` global; `web_interact` fails
  with a clear pointer to the manual CDP recipe (pi-ux `ux-capture` skill) on
  older runtimes.
- Smoke: `npx tsx extensions/scripts/cdp-smoke.ts` (real Chrome) verifies
  trusted-click activation (`execCommand('copy')` → true), type+Enter submit,
  wait_for, honest 390px probe, overflow detection, PNG magic bytes.

## 0.15.0 (2026-09-14)

### Added

- **`web_image` `size` parameter (zai/custom)** — pass-through as `WxH` in the
  OpenAI-images body; omitted when unset so the server default applies.
  `glm-image` enums: `1280x1280` (default), `1568x1056`, `1056x1568`,
  `1472x1088`, `1088x1472`, `1728x960`, `960x1728`. Portrait prompts should
  pass a portrait size — the default is a square. Verified live end-to-end:
  `size=960x1728` is honored exactly, and a long artistic portrait prompt
  generates on-prompt (lighting-drama stochasticity remains — request `n=2-3`
  and pick, same as the image.z.ai web UI effectively does).
- `gemini-smoke.ts` zai mode accepts an optional positional size:
  `npx tsx extensions/scripts/gemini-smoke.ts "prompt" zai 960x1728`.
- A present-but-invalid `size` (not `WxH`, 3-4 digits each) is rejected with a
  descriptive error instead of silently generating at the server default; chain
  pass-through pinned by a `generateImageWithFallback` test.

### Notes

- Quality review vs the image.z.ai web UI (vision critique, same prompt):
  the official `glm-image` API delivers long artistic prompts faithfully
  (scene/subject/wardrobe/setting at parity); the residual web-UI edge is
  lighting drama (branch shadows across the face, blown highlights, flare) —
  prompt emphasis + multi-sample selection closes most of it client-side.
  No extra backend wired; the reverse-engineered image.z.ai proxy path stays
  unwired by decision (gate evidence: official API fit, 1h session-JWT cost).

## 0.14.0 (2026-09-14)

### Added

- **ChatGPT web tier (`chatgpt` provider) — chat + images, direct, no bridge**:
  pi-web now talks to `chatgpt.com/backend-api/codex/responses` (the surface
  the official Codex CLI uses, on your ChatGPT subscription) with plain-Node
  Bearer auth — the literal web UI is Cloudflare-Turnstile-gated and
  unreachable headless, this is the reachable headless path on the same
  subscription.
  - `web_chat provider=chatgpt` (default when a credential is found): one-off
    chat on the gpt-5.x codex catalog (default `gpt-5.5`, `CHATGPT_WEB_MODEL`
    override, fallback to `gpt-5.5` on unknown-model); `system` maps to
    `instructions` (arbitrary prompts accepted — pi's own openai-codex
    provider precedent).
  - `web_image provider=chatgpt` (second in the auto chain: gemini → chatgpt
    → zai → custom): the `image_generation` Responses tool — the same
    gpt-image family as chatgpt.com/images/ — returned as base64 PNG and
    saved to disk; one image per call, `n` loops sequentially, server-rewritten
    image knobs surfaced as a note; bills the metered Codex-usage bucket and
    is covered by `WEB_IMAGE_DAILY_CAP` (default 20/day).
  - Credential resolution: `CHATGPT_WEB_AUTH_KEY` (the tokens JSON from
    `codex login`, or a bare access-token JWT — opaque bridge/API keys are
    rejected with an explanatory hint) → `CHATGPT_WEB_CODEX_AUTH`/
    `~/.codex/auth.json` → Pi auth.json `openai-codex`. Expired tokens
    auto-refresh via `auth.openai.com` (single-flight; rotated tokens persist
    back to the codex file, or to `~/.pi/agent/chatgpt-web-auth.json` (0600)
    when the source can't be rewritten — next session adopts the persisted
    token via the stored pre-rotation key); 401/403 → one refresh-retry;
    `invalid_grant` → honest "run codex login again" error.
  - Security: the auth-store path (`CHATGPT_WEB_AUTH_STORE`) and model
    override (`CHATGPT_WEB_MODEL`) ignore untrusted project-cwd env files —
    a repo's `.env.local` can never steer where rotated refresh tokens are
    written; `CHATGPT_WEB_MODEL` from a project cwd is honored only when the
    project is trusted.
  - `web_status`: new `chatgptWeb` block (source/account/plan/token
    expiry/refresh availability — no secrets) + `imageProviders.chatgpt`.
  - Smoke modes: `chatgpt-auth`, `chatgpt "…"`, `chatgpt-image "…"`.
  - Live-verified against chatgpt.com on a real account: auth accepted,
    request shape validated, quota errors surfaced honestly (429 "The usage
    limit has been reached" on a free plan).

## 0.13.4 (2026-09-14)

### Fixed

- **defaultHttp cookie jar seeded case-independently** (reviewer): the jar
  read `headers.Cookie` (capital C) while callers pass lowercase `cookie`
  (chromeHeaders), so the jar was always empty — requests shipped both the
  real `cookie:` and an empty `Cookie:` header, and redirect hops rebuilt
  `Cookie: ""` instead of the session cookie. Now `extractCookieJar`
  (new, exported) finds the cookie key in any case, seeds the jar, and
  strips the original header so exactly one Cookie header ships per hop;
  hop-accumulated cookies now merge with the auth cookie.
- **DR report poll fails fast on auth rejection** (reviewer): 401/403 from
  batchexecute broke out of the poll loop immediately and surfaced in the
  partial-result note (`report poll rejected (HTTP 403) — session cannot
  read this conversation`) instead of silently re-polling to the full
  deadline (up to 30 min). 200-with-empty / 429 / 5xx still keep polling
  (server-state fluctuation is documented behavior).
- **poll-wait abort listener leak** (reviewer): the 20s wait added a fresh
  `abort` listener per iteration without removing it — ~30 leaked listeners
  per 600s run (MaxListenersExceededWarning at 10). Now `abortableSleep`
  (new, exported) removes the listener whenever the timer wins.
- **research pre-abort unit test performed real network I/O** (reviewer):
  it injected a `factory` that `geminiResearch` no longer reads, so the
  un-awaited DR promise fired a real GET to gemini.google.com from the test
  suite. Now injects an offline `drHttp` stub and asserts no network path.

## 0.13.3 (2026-09-14)

### Fixed

- **DR report-poll no longer returns plan transcripts as the report**: strings
  already seen in the plan/confirm turns are excluded from poll output
  (exact-match; turn-index filtering if a real fixture ever demands it).

### Changed

- **Browser-UA + client-hint injection for gemini.google.com requests**
  (`injectGeminiHeaderCap` → `injectGeminiRequestTweaks`): non-browser
  user-agents (axios's default) are replaced with Chrome-145 UA; sec-ch-ua /
  sec-fetch / accept-language hints are added when absent. Existing browser
  UAs are untouched; scope stays gemini.google.com-only (rotation's
  accounts.google.com call is unaffected). Verified live: ask and DR plan
  turns unchanged (working), wire-level UA replacement proven.

### Verified live (2026-09-14 fresh-cookie round)

- **Gemini web image generation is gated on browser-grade TLS
  fingerprints** — plain Node with the identical cookie, payload
  (`inner[79]=1`), and Chrome UA/client-hints refuses while a
  chrome-impersonating transport generates on the same cookie minutes
  apart. Payload and headers are exonerated; pi-web cannot offer Gemini
  images until it ships an impersonating transport (follow-up plan).
  `web_image` auto-fallback to `zai` is the working path (verified
  end-to-end, DNS whitelist permitting).
- **DR confirm (execution start) is similarly gated**: Node + Chrome UA →
  in-stream `BardErrorInfo [1097]`; chrome-impersonating transport on the
  same cookie → execution started. DR plan turns, ask, and rotation smoke
  behave as documented over Node.

## 0.13.2 (2026-09-14)

### Fixed

- **resolvePsidts is env-first** (reviewer, fixes a real footgun): a stored TS
  could permanently shadow a re-pasted env cookie for the same PSID (the
  poisoned-store trap). Now the env paste ALWAYS wins; the store is only a
  restart fallback when the env has no TS (users who delegate cookie
  ownership to pi after an opt-in rotation).
- RotateResult stale doc corrected: rotation failures never clear the store
  (informational flag only).
- ensureKeepalive hooks gained an intervalMs override (tests/power users);
  tick pass-through and defaultPost redirect/no-follow behavior now
  socket-tested.

## 0.13.1 (2026-09-14)

### Fixed

- README env table corrected: GEMINI_WEB_KEEPALIVE default is **off**
  (opt-in via =1), matching the 0.13.0 behavior flip (advisor catch — the
  table still documented the pre-0.13.0 default).

## 0.13.0 (2026-09-14)

### Changed

**BREAKING (behavior): cookie auto-rotation is now OPT-IN and off by default**
(`GEMINI_WEB_KEEPALIVE=1` enables it). Live testing on a fresh cookie produced
a decisive reversal: a `__Secure-1PSIDTS` issued by Google's RotateCookies
endpoint is **rejected by gemini.google.com's privileged surfaces** — Deep
Research returns no plan, image generation 403s — while the **original pasted
cookie keeps serving content and DR plan/confirm indefinitely** (observed
19+ hours of authed ask on a static paste). Rotation was poisoning the very
session it was keeping alive.

- `ensureKeepalive` no longer arms by default and no longer fires an eager
  first rotation; the interval/cadence knobs remain for opt-in users.
- Rotation failures (400/401/403/5xx/offline) **never delete the stored
  paste cookie** — the store is only written by successful rotations or the
  passive jar persist.
- `web_research research` runs the pure-Node DR client (0.12.0) which is
  unaffected by the rotated-TS rejection: on a live session it executes the
  full cycle; on degraded sessions it returns an honest partial result
  (plan/confirm transcript) instead of a misleading 1184.
- README "Keeping the session alive" rewritten: harvest from incognito,
  keep the source browser session closed, and treat rotation as an
  experimental diagnostic.

## 0.12.3 (2026-09-14)

### Fixed

- **Keepalive fresh-store skip is psid-scoped** (reviewer, blocking): a fresh
  store belonging to a different psid no longer suppresses the immediate
  take-ownership rotation for a newly pasted session.
- **403 no longer wipes the cookie store** (reviewer): only definitive
  400/401 clear it — 403 (rate-limit/abuse soft-block) keeps the newest TS.
- **Cookie store writes are atomic** (reviewer): write-to-temp + rename —
  concurrent readers never observe an empty/partial store.
- Keepalive arming now covered by tests (disable flag, env interval,
  clamp, psid re-arm) via a __keepaliveDebug test hook.

## 0.12.2 (2026-09-14)

### Changed

- **Eager first rotation on keepalive arm**: instead of waiting a full 10-min
  interval, pi rotates immediately when a session is first used — minimizing
  the window where the pasted TS could be superseded by another client
  (a superseded generation cannot rotate again; recovering requires a full
  re-paste, as demonstrated by the lost-generation incident this round).

## 0.12.1 (2026-09-14)

### Fixed

- **RotateCookies requires a browser User-Agent** (found live, fresh-cookie
  testing): accounts.google.com answered 400 to the rotation POST when sent
  with the default axios UA — even with a perfectly valid cookie. The
  rotation request now sends the Chrome-145 UA + client hints; verified
  200 + fresh __Secure-1PSIDTS with the identical cookie pair.

## 0.12.0 (2026-09-14)

### Added

- **Pure-Node Deep Research client** (`lib/gemini-dr.ts`) — research mode no
  longer routes through gemini-reverse's drifted research path (source of the
  1184 / "research_id missing" failures). The new client speaks the validated
  wire protocol directly: init with redirect-following cookie jar → plan turn
  (deep-research flags + Chrome client headers) → "Start research" confirm
  turn → poll LIST_CONVERSATION_TURNS until the report text lands. Plan and
  confirm turns are proven live on a stale session (2026-09-14); report
  polling requires the session XSRF token, so on degraded sessions the tool
  returns an honest partial result (plan + transcript) instead of 1184.
  Fixture-tested against captured real responses (279→280 tests).

### Fixed

- **Poll-turn filtering in Deep Research** — report polling no longer accepts
  the first long string it sees: plan/confirm turn transcripts (which reappear
  verbatim in conversation polls) are excluded, so a plan transcript can no
  longer be mislabeled as the report.

### Changed

- **Docs: dropped the "research fails with 1184" claims** from the web_research
  tool description and README — false under the new transport; kept honest
  cookie/session requirements (fresh `__Secure-1PSIDTS`, live-session poll
  token, partial-result fallback). Removed the stale `cogview` keyword
  (models removed in 0.9.1).

## 0.11.9 (2026-09-14)

### Changed

- **Map the research polling-drift error** (herdr test round 7): gemini-reverse
  now sometimes fails research with "Cannot poll: plan.research_id is missing."
  after the plan step engages — a third distinct failure shape this week (1184 /
  DR-agent greeting / missing research id), confirming server-side protocol and
  session-state instability rather than a stable tier gate. This error now maps
  to a protocol-drift explanation instead of surfacing raw.

## 0.11.8 (2026-09-13)

### Fixed

- **web_image gemini creates out_dir before generating** (reviewer,
  blocking): a non-existent out_dir no longer fails the gemini tier with
  ENOENT after the generation was already spent — parity with the
  zai/custom API path.
- **Abort during the image download phase surfaces as AbortError**
  (reviewer, blocking): a cancelled download is no longer swallowed as a
  per-image downloadError, and the 404-retry backoff sleep is abortable —
  cancelled calls now return promptly instead of pending up to ~6s.
- **Content-Length precheck before buffering** (reviewer): oversized
  downloads are rejected at the start of the transfer when the response
  declares its size, instead of buffering multi-GB bodies first.

## 0.11.7 (2026-09-13)

### Fixed

- README rotation-failure guidance now includes **403** among the definitive
  dead-session statuses (400/401/403), matching the code — a 403 previously
  got the wrong "retry later" advice (advisor nit).

## 0.11.6 (2026-09-13)

### Fixed

- **raceGuard: pre-aborted calls no longer risk a fatal unhandledRejection**
  (reviewer, blocking): when the abort signal is already set, the guarded
  promise is marked handled before the AbortError propagates, so a later
  rejection of the underlying client call is swallowed. Regression test
  asserts zero unhandledRejection events.
- **Cookie-store persistence is best-effort** (reviewer): a store write
  failure (EACCES/ENOSPC/read-only path) after a successful ask/research/
  image call no longer converts the succeeded call into an error (tested
  with a read-only store directory).
- **web_image gemini: image-collection fallback made real + tested**
  (reviewer): fall back to `images` only when `generated_images` is empty
  (gemini-reverse always defines it, defaulting to []); added tests for the
  fallback, the text-preview refusal error, and the missing-newChat shape
  error.

## 0.11.5 (2026-09-13)

### Fixed

- **web_image reports an n shortfall**: when the upstream model returns fewer
  images than requested (Z.ai glm-image returned 1 of 2 requested in live
  testing), the result now carries a note instead of being silently short
  (found in herdr test round 3).
- The web_research tool description now carries the hedged Deep Research
  wording (0.11.3 pass missed the tool-description surface).

## 0.11.4 (2026-09-13)

### Fixed

- **Transient rotate failures no longer wipe the cookie store** (reviewer):
  `stale` (store-clearing) is now reserved for definitive rejections
  (400/401/403); 429/5xx/3xx/200-without-rotation keep the store like
  transport errors. Regression-tested with a 503.
- **Cookie store file is 0600 from creation** (reviewer): `writeFileSync`
  mode, no world-readable window before the chmod.
- **`http.request(url, options, cb)` 3-arg form preserved** (reviewer): the
  header-cap monkeypatch no longer converts string/URL first args when an
  options object follows — the cap merges into that object instead, so other
  in-process extensions using that form are unaffected.
- **`GEMINI_WEB_COOKIE_STORE` now resolves from `.env.local` files**
  (reviewer) via `findEnvValue`, consistent with every other `GEMINI_WEB_*`
  setting.

## 0.11.3 (2026-09-13)

### Changed

- **Hedged the Deep Research tier claims** (advisor round): the 1184 message,
  the `research` guest guard, and README no longer assert "not an entitlement
  gate" as flat fact. Recorded evidence is mixed — free-tier plan creation
  succeeded once via a browser-grade client (2026-09-13), while Gemini's own
  answers described Deep Research as Pro/Ultra-gated — and the only 1184 seen
  in the 2026-09-14 test round came from a dead-cookie session, where the
  code is known to be unreliable. All surfaces now state both facts and mark
  the tier requirement unverified.

## 0.11.2 (2026-09-13)

### Fixed

- **Corrected the 1184 error message** (missed in the 0.10.6 doc correction):
  `Unknown API error: 1184` no longer claims Deep Research needs a Gemini
  Advanced subscription — it is a transport artifact (browser-grade clients
  succeed on free-tier accounts); live-tested through a herdr pi session.
- `web_image` gemini no-images error now also mentions a degraded/stale web
  session as a possible cause (observed: ask works while the image tool is
  refused on the same half-alive session).

## 0.11.1 (2026-09-13)

### Changed

- **Scope the cookie-rotation guarantee precisely** (advisor round): the
  "works for DBSC-bound sessions too" finding is a single third-party
  experiment (notebooklm-py#345/#312 — and its "gated off" observation applies
  to the `CheckCookie` endpoint, not `RotateCookies`); pi-web's supported path
  remains incognito/unbound cookies. The "no new `__Secure-1PSIDTS`" failure
  now says so explicitly, and README gained a scope note.

## 0.11.0 (2026-09-13)

### Added

- **Gemini cookie auto-refresh** — no more re-pasting `GEMINI_WEB_SECURE_1PSID`
  every 15–25 minutes. pi-web now rotates `__Secure-1PSIDTS` itself via
  Google's own rotation endpoint (`POST accounts.google.com/RotateCookies`,
  the endpoint Chrome calls; a third-party experiment reports it also covers
  DBSC-bound sessions, but pi-web's supported path is incognito/unbound
  cookies):
  - background keepalive rotates every 10 min while pi runs (Google's
    declared cadence; `GEMINI_WEB_ROTATE_INTERVAL_MS` to tune,
    `GEMINI_WEB_KEEPALIVE=0` to disable),
  - rotated values persist to `~/.pi/agent/gemini-web-cookies.json` (0600,
    `GEMINI_WEB_COOKIE_STORE` to relocate) and are preferred on the next
    start; a newly pasted cookie always wins,
  - every Gemini call persists server-side rotations, and an auth failure
    triggers one rotate-and-retry before erroring; a server-declared dead
    session clears the store so a fresh paste is never shadowed,
  - `web_status` reports store freshness (`geminiWeb.cookieStore`), and
    `gemini-smoke.ts x auth` smoke-tests rotation directly.
  Harvest cookies from a fresh **incognito** login (daily-browser cookies are
  DBSC-capped and compete with the rotation); see README "Keeping the session
  alive".

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
