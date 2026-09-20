# pi-extensions hardening round 4 — burn-pihard4-0920 (2026-09-20)

Deep-pass #2 on a different surface: **pi-a2a outbound client** (round 3 covered
`lib/server.ts`). Adjudicated by code reading, per the task.

## Frontier note (read this before the findings)

- `git ls-remote` at run time showed only two `burn-pi-*` branches:
  `burn-pi-secvuln-0919` @ f53a1a5 and `burn-pi-secvuln2-0920` @ 62807c6.
  **`burn-pihard3-0920` (ef8818d) has been DELETED from GitHub** (CreateEvent
  04:47Z in the repo event log; no DeleteEvent within the retained window; the
  commit is not fetchable by hash from GitHub nor present in the local
  /Volumes/Dev clone). If ef8818d is not recoverable, round 3's
  `lib/server.ts` fixes exist only in that deleted branch — worth a human look.
- This branch is therefore cut from the newest surviving pushed tip
  **62807c6** (secvuln2), exactly the documented stack base.
- origin/main has ALSO moved since the docs were written: main is at
  `2f3cbc5` (0.86.1 SDK re-lock + pi-web web_interact Chrome-death fix), flat
  package layout (no extensions/pi-a2a path), pi-a2a still 0.7.10 — secvuln2
  and this branch remain unmerged; merge decision stays user-gated.

## Finding (1, test-first RED→GREEN)

**F-1 · `a2a_status` GetTask polls dropped the gateway-origin SSRF pin**
(`pi-a2a/extensions/lib/client.ts`, `getTask`)

- `sendTask` pins `viaGateway` peers to their publishing gateway origin
  (`peer.gatewayUrl`, else configured gateway origins) because the
  self-hosted a2a-switchboard topology is LAN-hosted — private RFC1918
  addresses that `assertSafeUrl` refuses by design (that refusal is the
  SSRF guard working). `getTask`, the other half of the non-blocking
  dispatch flow, called `postJsonRpc` WITHOUT the pin → every
  `a2a_status` poll of a non-blocking dispatch to a LAN gateway died with
  "refused SSRF: … is a private/internal host" while the SendMessage
  dispatch itself succeeded. Loopback-based tests never caught it because
  loopback is explicitly allowed.
- Why it matters: asyncDispatch + a2a_status polling is the documented
  long-job flow, and the switchboard gateway is this deployment's primary
  topology (e.g. http://172.30.55.22:9920).
- Fix (minimal, parity): `getTask` derives the identical `gwOrigins`
  allowlist and passes it to `postJsonRpc`; card fetch skipped for
  proxied peers (a proxied card advertises the peer's DIRECT url, which
  the pin would then reject — same rationale/comment as sendTask).
  No pin derivable (`viaGateway` without `gatewayUrl` and no configured
  gateways) → unchanged plain `assertSafeUrl` refusal.
- Guard side pinned by tests: a poll URL outside the pinned gateway
  origin never reaches the wire; the private-range refusal holds when no
  pin is available.

## Tests (3 new, `pi-a2a/extensions/test/client.test.ts`)

1. LAN gateway (`172.30.55.22:9920`) + `viaGateway` + `gatewayUrl`:
   GetTask reaches the pinned origin, task state returned — **RED before
   the fix** (verified: 1 failing), GREEN after.
2. Hijacked peer URL outside the pinned origin: no POST on the wire,
   SSRF error surfaces.
3. `viaGateway` with no derivable pin: plain SSRF refusal unchanged.

## Verification

- `npm ci` clean (root + pi-a2a).
- Full pi-a2a suite: **407 passing / 3 pending / 0 failing**
  (baseline 404/3 + 3 new; the round-3 era suite baseline carried in the
  task prompt was 406/3 from the now-deleted hard3 branch).
- `tsc --noEmit` clean.
- Only `getTask` caller is `a2aStatus` — no other behavior surface shifts.
- Diff grepped against live `/Users/bacnh/.hermes/.env` values: **0 hits**.

## Version

- `@bacnh85/pi-a2a` 0.7.11 → 0.7.12 (CHANGELOG entry added).

## Still open (unchanged, deliberate)

- M-1 `web_interact` dialog arming — documented user decision, not touched.
- M-2 `apply_patch` absolute-path pass-through, M-3 `/Volumes` races —
  boundary/OS-layer, previously adjudicated.
- Round 3's server.ts fixes: unmerged AND branch-deleted — see frontier note.
