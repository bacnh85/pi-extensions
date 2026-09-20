# pi-extensions hardening round 3 — burn-pihard3-0920 (2026-09-20)

Pickup: branch `burn-pi-secvuln2-0920` (commit 62807c6, unmerged). Both prior
sweep docs read before work; nothing duplicated. Scope chosen: **deep-pass
candidate #1** — a full trace of the `pi-a2a` server dispatch pipeline for
configured-token leaks beyond the four outbound sites the first two rounds
covered — plus the standing M-1 decision documentation (0919 item 3).

## Trace result: two missed outbound sites (fixed, test-first)

Enumerated every path where worker/error output can reach a peer or the
process boundary (`store.update` payloads, JSON-RPC replies, SSE frames,
push notifications, progress fan-out, audit). Two sites failed the trace:

**SSE-1 · `message/stream` last-resort error frame leaked raw exception text**
- `extensions/lib/server.ts`, the `.catch((e) => writeErr(-32603, e?.message
  || String(e)))` tail of the streaming promise chain. Any rejection that
  escapes `messageSend` without `executeTask` classifying it lands here and
  rides the SSE wire **verbatim**. The 0919 sweep fixed the reply artifact,
  internal-error message and failure message; this frame was never covered.
- Fix: the frame text now passes `redactConfiguredTokens(text, cfg,
  { extraTokens: this.mintedInboundTokens })` chained before `redactOutbound`
  — the identical chain used at the other four boundaries.

**SSE-2 · escaping rejections crashed the server process (the 500 catch was
unreachable)** — worse than a leak.
- `handle()` wraps dispatch in try/catch and returns `this.handlePost(req,
  res)` **inside the try**. In an async function, the promise returned by
  `handlePost` is adopted *after* the catch clause, so a rejection from the
  dispatch chain is invisible to the `catch (e)` that sends
  `{error:"internal", message: e.message}`. And node:http discards the
  request-handler callback's promise — so the rejection became an
  **unhandled rejection, which terminates the Node process**: any single
  escaping throw (e.g. an `onActivity` UI listener throwing synchronously
  out of `messageSend`, verified live in the RED reproduction) took down the
  whole a2a server, all in-flight tasks with it.
- Fix (two layers):
  1. the `createServer((req, res) => this.handle(req, res))` listener now
     `.catch`es `handle()`'s promise and sends a best-effort 500;
  2. that 500's `message` field passes the same redaction chain as SSE-1,
     so error text with configured/minted token values or credential shapes
     never crosses the boundary. (The original in-`handle` catch stays —
     its `message` was already redacted in 0919 — for genuinely synchronous
     throws up to the `readBody` await.)

## Tests (RED verified before each fix, now GREEN)

`pi-a2a/extensions/test/server.test.ts`, in the `outbound reply redaction`
block, both HTTP-boundary pins with a configured `sharedToken` embedded in a
`:token@` URL inside the injected error:
- `redacts the message/stream SSE error frame (last-resort catch, hard3 0920)`
- `redacts the blocking JSON-RPC 500 (top-level handle catch, hard3 0920)`

RED run: 404 passing / 3 pending / **2 failing** — the two new pins, on the
exact assertions (SSE frame contained `pin-shared-token-99887766`; the
blocking-path test instead exposed the crash: mocha timeout, server process
dead with an unhandled-rejection stack at `messageSend`).
GREEN run: **406 passing / 3 pending / 0 failing** (baseline 404 + 2).

## M-1 `web_interact` dialog arming — decision documented, NOT implemented
(product decision, per the 0919 doctrine)

Current mechanics (verified in `pi-web/extensions/lib/cdp.ts`, all already
regression-pinned in `cdp.test.ts`): native dialogs auto-DISMISS by default;
`{"dialog":"accept"}` arms exactly the next step (one-shot, unconsumed arms
expire at the next step boundary); every dialog is reported per-step. The
residual risk is purely prompt-injection convincing the model to arm accept
before a destructive click.

Options for the product decision (pi-web `web_interact`):
1. **Confirm hook (recommended)** — when a `dialog:"accept"` step actually
   fires `Page.handleJavaScriptDialog {accept:true}` on a dialog that was
   opened during a step **other than** the arm's target step, treat it as a
   hard permission event: route through pi's permission system (the same
   gate that guards external-directory writes) instead of a silent accept.
   Cheap: the arm/step pairing is already tracked. Preserves the one-call
   UX for the 99% case (arm → click → accept).
2. **Per-origin accept allowlist** — `{"dialog":"accept"}` requires the
   origin to be in a config list; anywhere else falls back to dismiss with
   a loud step report. Safer, but breaks exploratory flows on new origins
   (the main use case for the tool) and adds config surface.
3. **Remove accept entirely** — keep auto-dismiss only; accepting requires
   the operator to drive the dialog manually. Safest, but legitimately
   kills real flows (beforeunload-protected editors, login confirms).
Recommendation: option 1, implemented as a pi permission prompt with a
"session" scope. Not implemented this round: it changes tool semantics
(pi-core permission plumbing), not surgical.

## Verified clean this round (read-only)

- `onActivity` fan-out remains local-UI-only (unchanged from 0920's trace);
  SSE replays only stored (redacted) artifacts; push notifications stay
  disabled (`pushNotifications: false` in the card).
- `audit()` is try/catch-wrapped and self-redacting (cannot throw into
  dispatch; preview can't carry tokens to disk).
- `tasks/get`, `tasks/list`, `tasks/cancel`, `tasks/subscribe` return only
  stored (already-redacted) task state; ownership checks intact.
- `authenticate()` `extraTokens` path: identity lookup only, never the
  `hasTokens`/`localhostOnly` decision (confirms 0920's finding #2).
- pi-web M-1 mechanics: auto-dismiss default, one-shot arm, arm expiry —
  all already pinned by existing cdp.test.ts regression tests.

## Version

- `@bacnh85/pi-a2a` 0.7.11 → **0.7.12** (CHANGELOG entry added).

## Verification

- `pi-a2a`: `npm ci` clean (0 vulnerabilities), typecheck OK, **406 passing
  / 3 pending / 0 failing**. No other package touched → per-package gate
  = pi-a2a only (no shared code changed; files: server.ts, server.test.ts,
  CHANGELOG.md, package.json).
- No secret material in the diff: the only token-looking strings are the
  synthetic `pin-shared-token-99887766` carried over from the 0920 pins;
  diff grepped against live `.env` token values — zero hits.

## Quota

glm-pihard3-0938 @ 2026-09-20 11:22–11:50 +07: 5H window 58% used / 42% left
(reset 15m), TIME_LIMIT 46% used / 54% left; logged GLM runtime today
703m / 300m budget. Stop command run at round end.
