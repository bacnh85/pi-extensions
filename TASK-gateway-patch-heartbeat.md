# TASK: gateway heartbeat → PATCH /register (dispatched by switchboard maintainer)

The a2a-switchboard just gained `PATCH /register` (partial peer self-update,
auth via the per-peer caller_token). pi-a2a's gateway client should adopt it.

Repo: `/Volumes/Dev/agents/pi-extensions/pi-a2a` (was clean on `main` @ `220da68`).
Work on branch `feat/gateway-patch-heartbeat`.

## Switchboard PATCH /register semantics

(Live on local board 127.0.0.1:9920. NOT yet on remote 172.30.55.22 — still 405s.)

- Auth: original shared token (fingerprint-matched) **or** the peer's own caller_token
- Body: `{name (required), url?, card?, upstream_token?}` — partial; unspecified
  fields keep previous values; admission state unchanged
- Codes: 200 updated · 401 no/bad auth · 403 revoked · 404 unknown peer name ·
  405 old binary · 409 different identity
- caller_token is disclosed by the switchboard **only at mint** (first register,
  or first re-register of a pre-upgrade peer). Never again.

## Changes (extensions/lib/gateway.ts + tests)

1. **Persist caller_token per gateway key** (e.g.
   `~/.pi/agent/a2a_gateways/<key>.json`: `{url, name, callerToken}`).
   Today it's memory-only — after restart it's lost forever (switchboard won't
   re-disclose; deregister+register is the only recovery). Load at start.
2. **`GatewayUpstream.register()` (L~269)**: first registration on fresh start
   stays `POST /register` with the shared cfg.token (only way to mint
   caller_token / register when unknown). Subsequent heartbeats: when
   callerToken is known, use `PATCH /register` with
   `Authorization: Bearer <callerToken>` and body `{name, url, card}` (full card
   refresh is the point; url re-send covers IP change).
   On PATCH failure (405 old gateway / 401) → fall back to POST with shared
   token, re-capture caller_token if the response mints one, remember which
   method works to avoid flapping. Keep existing epoch/stop-race guards.
3. Directory fetch (`/.well-known/agent.json`) keeps using the SHARED token — unchanged.
4. **Tests** in `extensions/test/gateway.test.ts` (heartbeat suite, fetch-mock
   style already there):
   - heartbeats use PATCH with caller_token after the initial POST captured it
   - PATCH 405 → falls back to POST, succeeds (old switchboard)
   - persisted caller_token → fresh GatewayUpstream heartbeats with PATCH immediately
   - PATCH 401 → fallback POST re-mints
   - existing tests keep passing (esp. "falls back to shared token when
     register omits caller_token")
5. README: gateway section — heartbeat method table
   (POST mint / PATCH steady-state / POST fallback), note caller_token persistence.
6. **Verify**: `npm run check` (tsc --noEmit + mocha) — all green.

## Reply

Reply to the dispatching conversation with: branch name, files changed + diff
stat, new test names, npm check result. Keep the diff minimal — this is a
heartbeat-path change, not a rewrite. The maintainer will review the branch
after the reply.
