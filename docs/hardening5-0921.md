# pi-extensions hardening round 5 — burn-pihard5-0921 (2026-09-21)

Deep-pass #3 on a surface not covered by rounds 3–4: the **pi-a2a reverse
gateway channel** (`lib/gateway.ts`, `ChannelClient`). Round 3 covered
`lib/server.ts`, round 4 `lib/client.ts`, secvuln 1–2 the `lib/security.ts`
redaction chain. `lib/gateway.ts` (upstream registration + SSE reverse
channel) had none.

## Frontier

- Base tip: **burn-pihard4-0920 @ 3e29e8f** (round 4 DID land and is present
  on the remote — its own doc's frontier note about a missing hard3 branch
  stands; `git ls-remote` this run shows 4 burn-pi-* branches incl. both
  hardening tips). Branch cut from 3e29e8f, stacked per the documented chain
  secvuln-0919 → secvuln2-0920 → hard4-0920. main untouched.

## Findings (2, both test-first RED→GREEN, in `ChannelClient`)

**F-1 · Undecodable envelope body rejected unhandled (session-killer class)**
(`pi-a2a/extensions/lib/gateway.ts`, `dispatch`)

- Envelope dispatch is fire-and-forget (`const p = this.dispatch(env);
  this.inflight.add(p); void p.finally(...)`), so anything thrown inside
  `dispatch` surfaces as an unhandled rejection. The `atob(env.body_b64)`
  decode sat OUTSIDE the method's try/catch (the try only wraps the local
  fetch): a hostile/buggy gateway frame with malformed base64 — Node's atob
  throws `InvalidCharacterError` on `!!`, `=` mid-string, bad padding, or
  length % 4 == 1 — killed the frame pipeline with an unhandled rejection.
  In the Pi host process an unhandled rejection is fatal (crashes the
  session); one corrupt SSE frame from the gateway was enough.
- RED evidence: test captured `process.on("unhandledRejection")` and
  observed exactly `InvalidCharacterError: Invalid character` before the fix.
  (First RED attempt with bare assertions passed silently — mocha absorbs
  the rejection; the explicit process handler is what makes the RED state
  observable and the GREEN assertion meaningful.)
- Fix (minimal): `decodeEnvelopeBody()` helper — decode in try/catch, null on
  garbage — envelope dropped with a log line (`dropped envelope with
  undecodable body (N b64 chars)`), channel survives, next envelope flows.
  Typed `Uint8Array<ArrayBuffer>` so the fetch `body:` typing stays exact.

**F-2 · Unbounded SSE frame accumulator (memory-exhaustion class)**
(`readStream`)

- The 4 MiB envelope guard (`MAX_B64`) lives in `handleFrame`, which only
  runs once a blank-line delimiter arrives. `readStream` accumulated `buf`
  with no cap: a gateway streaming `data:` lines that never sends the
  delimiter grows the string without limit — the envelope guard can never
  trigger, and the 10s fetch timeout doesn't apply to a streaming body.
  This defeats the file's own hostile-gateway posture (size guard, path
  check) for one trivially reachable path.
- Fix (minimal): when `buf.length > MAX_B64` — larger than the largest legal
  frame can ever be — log `dropped oversized undelimited SSE stream` and
  abort the stream (`this.controller?.abort()`), reconnecting fresh through
  the existing capped-reconnect loop. Legal traffic never approaches the
  bound (a legal envelope is at most ~MAX_B64 chars of frame).

## Tests (2 new, `pi-a2a/extensions/test/gateway.test.ts`,
`reverse channel hardening` block, same fake-gateway HTTP style as the block)

1. Undecodable body then a valid envelope: zero unhandled rejections
   (explicit process-handler capture, deterministic), drop logged, valid
   envelope still dispatched. **RED before the fix** (verified: 2 failing).
2. Undelimited flood (64 KiB `data:` lines every 20 ms, ~2 s): stream cut,
   "oversized undelimited" logged. **RED before the fix** (verified).

No exported-for-test backdoors: both tests drive the public `start()`/`stop()`
over real HTTP, like the existing hardening block.

## Verification

- `npm ci` clean (root + pi-a2a), 0 vulnerabilities.
- Full pi-a2a suite: **409 passing / 3 pending / 0 failing**
  (baseline 407/3 from round 4 + 2 new).
- `tsc --noEmit` clean (one real catch during the round: annotating the
  decode result as plain `Uint8Array` widened the type to `ArrayBufferLike`
  and broke the fetch `body:` assignment — helper keeps the exact
  `Uint8Array<ArrayBuffer>`).
- Diff grepped against live `/Users/bacnh/.hermes/.env` values: **0 hits**.

## Version

- `@bacnh85/pi-a2a` 0.7.12 → 0.7.13 (CHANGELOG entry added).

## Still open (unchanged, deliberate)

- M-1 `web_interact` dialog arming — documented user decision, not touched.
- M-2 `apply_patch` absolute-path pass-through, M-3 `/Volumes` races —
  previously adjudicated.
- Other gateway.ts surfaces read this round with no finding: merge/self-filter
  (hostile-directory hardened: name regex, single-line caps, same-origin
  proxy URL pin), token persistence (0600/0700 modes, name-matched),
  heartbeat/backoff (Retry-After capped), epoch stop-race guards — the
  upstream half is in good shape; the channel half had the two gaps above.
