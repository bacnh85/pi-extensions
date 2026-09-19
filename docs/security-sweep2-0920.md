# pi-extensions secvuln FOLLOW-UP FIX round — burn-pi-secvuln2-0920 (2026-09-20)

Pickup: branch `burn-pi-secvuln-0919` (commit f53a1a5) landed with
`docs/security-sweep-0919.md`. This round fixes its test-pinnable leftovers,
test-first, no unrelated behavior change.

## Fixed (test-first — RED verified before each fix)

**L-1 · audit log previews stored raw** (`pi-a2a`)
- `security.ts` `audit()` wrote `text.slice(0, 300)` unredacted, so a token
  echoed in task text landed in `<piDir>/a2a_audit.jsonl` in plaintext.
- Fix: `audit()` now redacts BEFORE truncating (slice-then-redact could keep a
  token verbatim inside or straddling the window — pinned by a test with the
  token placed beyond the 300-char cut). New optional `config` + `extraTokens`
  params; all audit callers in `server.ts`/`client.ts` pass them; audit stays
  best-effort (no config → shape-based pass only).

**H-1 class extension · minted inbound gateway tokens were outside the
redaction set** (`pi-a2a`)
- `agw-…` caller tokens minted per server start (gateway entries without an
  explicit `upstreamToken`), persisted under `<piDir>/a2a_gateways/`, accepted
  via `authenticate()`'s `extraTokens`, are live credentials — but they live in
  the server-side `mintedInboundTokens` map, not cfg, so the 0919
  `collectConfiguredTokens(cfg)` could not see them. A worker reply echoing one
  crossed the boundary verbatim (same leak class as H-1).
- Fix: `collectConfiguredTokens` / `redactConfiguredTokens` accept an optional
  `{ extraTokens }` (back-compat: all existing 2-arg calls unchanged), wired
  into all four outbound sites + every audit call via
  `this.mintedInboundTokens`. Works even when cfg is undefined.

**Regression pins for the H-1 wiring itself** (`pi-a2a`)
- 0919 verified `redactConfiguredTokens` at unit level only; nothing failed if
  the server stopped chaining it. New HTTP-boundary tests: configured
  `sharedToken` echoed in a reply artifact and in a failure message must be
  `[redacted-token]` on the wire; minted token echoed in a reply likewise.

## Verified clean (deep-pass candidates from the 0919 doc, read-only)

- **#2 gateway upstream / minted-token confusion in `authenticate()`**:
  extraTokens are consulted for identity lookup ONLY — never for the
  `hasTokens` / `localhostOnly` decision (code-commented + structurally
  separated from cfg). Panel-edit flows mutate cfg entries, not the minted map.
  No confusion path found.
- **#4 commandcode provider error bodies**: `pi-commandcode` has zero
  spawn/exec surface (fetch-only client); provider error text lands in thrown
  `Error` messages, never in command lines. Clean.

## Still open (recommendations, unchanged)

- M-1 `web_interact` dialog arming (needs a product decision, not surgical).
- M-2 `apply_patch` absolute-path pass-through (boundary is pi permissions).
- M-3 `/Volumes` mount races at the OS layer.
- Deep-pass #1 residual: worker-output fan-out beyond the four covered sites
  was traced this round — `onActivity` (progress/completed events) is
  local-UI-only (never serialized to a peer), SSE replays only stored
  (redacted) artifacts, push notifications are disabled
  (`pushNotifications: false` in the card). No further leak path found.

## Verification

- `pi-a2a`: typecheck OK, **404 passing / 3 pending / 0 failing** (baseline
  395/3 + 9 new tests; the 2 pre-existing modified tests unchanged in intent).
- CI gate for this diff (paths-filter) = pi-a2a `npm ci && npm test && npm run
  typecheck`.
- No secret material in the diff: all token strings are synthetic
  (`pin-shared-token-99887766`, `agw-minted01abcdef0123456789abcdef`, …); diff
  grepped against live `.env` token values — zero hits.

## Version

- `@bacnh85/pi-a2a` 0.7.10 → 0.7.11 (CHANGELOG entry added).
