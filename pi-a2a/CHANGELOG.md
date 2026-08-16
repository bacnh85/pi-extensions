# Changelog

## 0.6.0 — 2026-08-16

### Added

- **Multiple a2a-switchboard gateway upstreams.** New
  `discovery.gateways` map (`{ <key>: {enabled,url,token,name?,upstreamToken?,heartbeatSec?,channel?} }`)
  registers this session with N gateways at once — each registers, heartbeats,
  opens its reverse channel, and refreshes its peer-directory overlay
  independently. The legacy single `discovery.gateway` block (settings or env)
  keeps working and coexists.
- **`/a2a-config` Gateways group**: per-gateway rows (enabled/url/token/name/
  upstreamToken/heartbeat/channel, tokens masked) plus `+ Add gateway` /
  `− Remove gateway` actions (key must match `[A-Za-z0-9._-]{1,64}`).
- Per-gateway registration names for `X-Gateway-Caller` attribution.

### Changed (breaking)

- **Gateway proxy peers are now ALWAYS namespaced by gateway key:**
  `gw/<name>` → `gw/<key>/<name>`. The legacy `gateway` block uses a key
  derived from its URL host-port (e.g. `gw/127.0.0.1-9920/<name>`); map keys
  are used verbatim. Old `gw/<name>` call names no longer resolve — use the
  `gateways` map with a stable key for predictable names.
- **SSRF pinning for gateway peers is per-peer:** each overlay peer carries its
  publishing gateway origin, so calls stay pinned even when the live config has
  no gateway block.
- **Gateway notifications are gateway-specific:** every status/diagnostic line
  now names the gateway — `[a2a] registered to a2a-switchboard <key>@<host> as
  <name>`, `[a2a] gateway channel open: <key>@<host> (firewall-safe receive)`,
  and `[a2a-gateway:<key>@<host>] …` for failures — so multi-gateway sessions
  are unambiguous.

### Fixed

- Stopping one gateway upstream no longer clears the other gateways' overlay
  peers (per-gateway overlay slices).

## 0.5.1 — 2026-08-15

### Fixed

- **Group-coherent config panel windowing:** the `/a2a-config` panel used to
  cut a category mid-way when the list scrolled (a group header could render
  with only some of its rows, looking detached). It now renders whole groups
  only — header + all its rows — and the window slides one group at a time.
  The first screen shows SERVER + DISCOVERY together, the next all remaining
  groups, so categories display like the settings.json structure.

## Unreleased

### Fixed

- **Reviewer follow-up (PR#12 round 2):** closed 7 review findings on the
  security fixes themselves:
  - `ctx.settings` a2a blocks are now sanitized too (the top-precedence
    branch bypassed the repo-file guard; dead code today — the SDK's
    ExtensionContext has no `settings` — but defended against future
    layered-settings SDKs).
  - Abuse-control keys (`server.rateLimitPerMin`, `maxConcurrent`,
    `maxPingpongTurns`, `replyTimeoutSec`) now stripped from repo settings,
    matching the env blocklist — a repo can no longer neuter rate limiting
    or the concurrency ceiling.
  - Repo-sourced peers never auto-attach the operator's shared token
    (the "known loopback peer" trust now requires an operator-configured
    source; prompt-injected `a2a_call(agent="helper")` to a repo-chosen
    loopback listener gets `auth: none`).
  - mDNS force-enable and card enrichment (`A2A_DISCOVERY_MDNS`,
    `A2A_ENRICH_CARD`, `discovery.mdns.enabled`, `discovery.enrichCard`)
    blocklisted from repo files (LAN/cwd/model disclosure).
  - README no longer recommends enabling the server via project-local
    `.pi/settings.json` (that path is now ignored for security keys).
  - Tests: ctx.settings injection, parent-dir `.env.local`, missing env
    blocklist keys, abuse-control strips, repo-peer no-auto-attach (plus
    operator-peer keeps-auto-attach regression), GET Host gate, `Origin: null`.

- **Repo-controlled `.pi/settings.json` is now sanitized (HIGH, completes #6):**
  the earlier fix only stripped security keys from repo `.env.local`; a
  malicious repo could still ship `.pi/settings.json` with
  `a2a.server.{enabled,host,sharedToken,peerTokens,trustedPeers,allowAllUsers,
  publicUrl}`, `a2a.discovery.{gateway,gateways}` (attacker gateway redirect),
  or `a2a.verifySsl:false`. Those paths are now stripped at read time from the
  repo-scope file only; operator-owned global settings and process env are
  unaffected. The config panel also no longer persists tokens into the
  repo-scope file (writes target operator-owned settings instead). Added
  `A2A_VERIFY_SSL` to the repo `.env.local` blocklist.
- **IPv6 loopback Host parsing (#7 follow-up):** `[::1]:9910` Host headers
  were mis-parsed to `"["` by `split(":")[0]` and falsely rejected with 403.
  Bracketed IPv6 is now split on `]` first; bare IPv6 compared whole.
- **Failure messages are redacted (#8 follow-up):** the FAILED task's
  `status.message` (error text can embed reply content) now passes through
  `redactOutbound()` like the reply artifact, before tasks/get or SSE
  returns it to a peer.

- **Inbound sessions now load host extension packages.** The task session
  runner created its `DefaultResourceLoader` with an in-memory
  `SettingsManager` that had no `packages` — the child session therefore ran
  WITHOUT any of the host's extension packages (pi-model-tools, pi-serena,
  …), silently disabling their hooks and tools. The loader now falls back to
  `SettingsManager.create(cwd, agentDir)` (the same path pi-subagent's runner
  uses), so inbound tasks behave like a real host session. This also fixes
  pi-model-tools' ds-anchor bootstrap, which never engaged in gateway-spawned
  sessions (observed: standard-like first thinking despite a pro model).
- **Inbound sessions inherit the host thinking level** instead of hardcoding
  `medium` (relevant for DeepSeek v4 Pro's minimal-mode recipe, which needs
  max thinking).
- **Gateway lifecycle lines no longer enter the LLM context.** `statusSink`
  routed `[a2a] registered…` / `gateway channel open…` through
  `pi.sendMessage`, and custom messages are converted to USER MESSAGES in the
  model context (buildSessionContext) — so every request was polluted with
  gateway noise, derailing DeepSeek v4 Pro's minimal-mode bootstrap (request
  #1 must be a clean user message). They now go through `ctx.ui.notify` only:
  still visible in the TUI as status lines, but never sent to the model.
  Headless modes (hasUI=false) fall back to stderr so the lifecycle stays
  observable (same pattern as `errorSink`).
- **Child sessions no longer auto-start an inbound A2A server.** The
  `session_start` auto-start is now guarded — SDK-created child sessions (a2a
  inbound tasks, pi-subagent children; hasUI=false + mode='print') would each
  construct their own A2AServer: same-pid registry overwrite, port climbing
  per task, duplicate gateway registration. Only host sessions serve inbound
  A2A (TUI/RPC via hasUI, and json-mode hosts via mode==='json').
- **Child sessions forward the host's project-trust decision** so project-
  local (`.pi/`) extensions load in inbound tasks when the user already
  trusted the project (matching pi-subagent's runner; never prompts).

- **Gateway diagnostics no longer interleave with lifecycle lines:**
  `[a2a-gateway] register failed …`, `channel dropped`, `dispatch failed`
  and other upstream/channel diagnostics used to print via raw
  `console.error`, rendering unstyled in the middle of the transcript right
  next to the `[a2a] registered…` / `[a2a] gateway channel open…` status
  lines. They now route to a dedicated error sink — a TUI error toast (a
  separate surface from the transcript status lines), falling back to stderr
  when headless. New optional `onError` hook on `A2AServer` wires it up.

### Added

- **Caller attribution to the gateway:** outbound calls routed through an
  a2a-switchboard (`peer.viaGateway`) now send `X-Gateway-Caller: <selfIdentity
  or gateway peer name>` so the gateway's dashboard/live log shows which peer
  made the call. Advisory display name only — the gateway strips it before
  forwarding and it is not an auth mechanism.
- **Per-peer caller tokens:** the gateway now issues a unique `caller_token`
  at `/register`; the overlay peers (`gw/<name>`) present it (instead of the
  shared token) for outbound `/peer/*` calls, so the gateway attributes them
  to this peer's name even without the header.

## 0.5.0 — 2026-08-15

Gateway configuration in /a2a-config + explicit enable/disable.

### Added

- **`discovery.gateway.enabled` flag:** the upstream a2a-switchboard registration
  is now explicitly toggleable. Defaults to `true` when `url`+`token` are both
  set and no explicit value exists (backward compatible with the implicit
  activation); explicit `enabled: false` disables registration entirely. New
  env var `A2A_GATEWAY_ENABLED`.
- **Gateway editor in /a2a-config:** a new Gateway panel group exposes the full
  settings.json block — registration toggle, URL, API token, peer name,
  upstream token, heartbeat (s), and reverse-channel toggle. Tokens render
  masked (`••••`) in the panel and inline-edit hints.
- **Persist gateway on edit:** the panel now writes `discovery.gateway` back to
  settings.json when a gateway field changed (env-sourced secrets are not
  copied on unrelated discovery edits).
- `/a2a-config show` now prints a gateway line (enabled/url/token-set).

### Fixed

- Live config overrides now merge `discovery.gateway` (previously dropped, so
  panel gateway edits could not apply without /reload).
- Server skips `startGatewayUpstream` when `enabled: false`.
- The reverse-channel "channel open" line now surfaces in the host transcript
  (`[a2a] gateway channel open (firewall-safe receive)`) like the registration
  message instead of raw console output in the chat window.
- **Reviewer fixes (persistence safety):** an existing `discovery.gateway`
  block in settings.json (enabled OR disabled) now survives unrelated panel
  edits byte-for-byte (discovery is merged, not replaced); a discovery-only
  edit no longer writes the full `server` block (env-sourced
  sharedToken/peerTokens stay out of settings.json); env-sourced gateway
  secrets are copied to disk only when the user edits that exact row; an
  empty submit on a masked secret row keeps the existing value instead of
  wiping it. Persistence logic extracted to `buildA2ASettingsPatch` and
  unit-tested.

## 0.4.0 — 2026-08-15

Discovery completeness + untruncated conversation view + gateway registration visibility.

- **Peer discovery shows ALL exposed tools:** `a2a_peers` / `/a2a-peers` previously capped the
  tool list at 8; now every advertised tool is listed (wrapped at 10 per line, matching the
  Agent Card metadata.tools). `a2a_discover` now also renders the full `Tools (N)` list from the
  card metadata (pi-session extension) instead of skills-only. Gateway peers surface their
  `caps=` tags.
- **Inbound messages are no longer truncated:** transcript lines carry the full task text and
  full assistant reply (previously capped at ~100-120 chars with a trailing …). Multiline text
  is preserved like a normal conversation turn; toasts stay short.
- **Gateway registration is visible in the transcript:** a successful a2a-switchboard registration
  now emits a `[A2A gateway] registered to … as …` line (plus toast) rendered like the
  `[A2A inbound]` activity lines, instead of being lost in console output.

## 0.3.1 — 2026-08-14

mDNS broadcast hostname-claim fix.

- **Fixed macOS hostname-rename conflict:** enabling mDNS advertising made
  `bonjour-service` publish A/AAAA records claiming the OS local hostname
  (its default when no `host` option is given), fighting macOS
  mDNSResponder's ownership → "This computer's local hostname … is already
  in use on this network" → the machine was renamed (e.g. `MBP-Sao-2.local`).
  Broadcasts now claim a unique per-session name
  (`<hostname>-a2a-<pid>.local`) that never equals the OS hostname, and the
  service instance name gets a pid suffix (`<agent>-<pid>`), so multiple Pi
  sessions on one machine no longer probe-collide on the same
  `<name>._a2a._tcp.local` fqdn.
- **Test-suite exit hang:** `npm test` could hang after a green run because the
  optional mDNS live-socket tests were always run (bonjour-service is a dev
  dep) and their sockets kept the event loop alive. They are now skipped by
  default (`MDNS_NETWORK_TESTS=1` opts in), so the suite exits naturally and
  leaks are still detected.
- **Restoring a pre-0.3.1 rename:** System Settings → General → Sharing
  (edit Name), or `sudo scutil --set LocalHostName <name>`.

## 0.3.0 — 2026-08-14

Inbound activity visibility + interactive config panel.

### Inbound activity in the host TUI

- When a remote peer sends Pi an A2A task, the host session now shows it:
  **arrival** (who sent it + task preview), **live progress** (tool calls and
  assistant text deltas from the isolated session, forwarded through the
  runner's `onProgress` channel), and **completion/failure** (state, elapsed,
  reply preview).
- Surfaced as **transcript messages** (`pi.sendMessage`, customType
  `a2a-inbound`) with a compact custom renderer, plus `notify()` toasts and a
  footer status line while tasks are in flight.
- New `a2a.ui.transcript` toggle (default `true`) — set `false` to keep only
  toasts + footer status and keep inbound activity out of the host LLM
  context. (Transcript messages become user-role context for the host agent;
  content is terse and `[A2A inbound]`-prefixed.)
- Server emits activity through an optional `onActivity` hook — fully
  testable, backward compatible (no hook = no UI, same as before).

### Interactive config panel

- `/a2a-config` now opens an **arrow-key config panel** (TUI mode) covering
  Server (enabled/port/host/agentName/timeouts/concurrency/rate-limit),
  Discovery (local registry/mDNS/enrich-card), Identity (selfIdentity), Peers
  (edit URLs, add/remove), and UI (transcript toggle).
- `/a2a-config show` (or non-TUI mode) prints the config summary as before.
- Saving persists to settings.json via a new `writeSettingsA2A` (read-modify-
  write, preserves unrelated keys, atomic rename) **and** applies live via
  in-memory overrides (`setConfigOverrides`) — no `/reload` needed. Server/
  discovery changes auto-restart the running inbound server.
- **Fixed panel runtime bugs** (0.3.0 patch): the panel no longer calls
  `ctx.ui.input()`/`confirm()`/`select()` while displayed — those open
  editor-container dialogs that render UNDER the overlay and fight overlay
  focus (symptoms: toggles not working, panel vanishing after typing a value,
  command unable to re-open). The panel now embeds its own inline `Input`
  component (empty prefill, old value shown as hint; Enter confirms, Esc
  cancels) and saves directly on Esc when dirty — the proven llama-extension
  single-component pattern. The component is also focusable (focused
  getter/setter) and scrolls rows (max 14 visible).
- **Fixed toggle-not-reflecting + width-crash** (0.3.0 patch 2): `row.set` now
  also updates `row.value` (stale value made toggles render "off" forever),
  and every rendered line is truncated to the overlay width via
  `truncateToWidth` (a long peer URL previously threw
  "Rendered line exceeds terminal width" and crashed Pi).
- New peer dep `@earendil-works/pi-tui` (panel component only).

## 0.2.0 — 2026-08-14

Session self-declaration + local discovery. Each Pi session running an inbound
A2A server now declares its identity (working folder, model, tools, pid, URL)
so other sessions can discover and delegate to the **right** peer without
port-scanning or manual config.

Three complementary layers, all opt-in and backward-compatible:

### Local file registry (zero-dep)

- Each session writes `<piDir>/a2a_registry/<pid>.json` with `{url, port, cwd,
  model, tools, sessionName, pid, mtime}`.
- Dual stale-entry GC: mtime TTL (default 60s) **and** `process.kill(pid,0)`
  liveness probe on every read → self-heals after crashes.
- Heartbeat rewrites the file every `heartbeatSec` (default 15). Timer is
  `unref`'d so it never blocks shutdown.
- New `a2a_peers` tool + `/a2a-peers` command list the merged peer set.
- `a2a_list` / `/a2a-agents` now append a "Discovered peers" section.

### Enriched Agent Card (standards-compliant)

- The Agent Card advertises an A2A v1.0 **Extension**
  (`https://bacnh85.dev/a2a/extensions/pi-session/v1`, `required: false`) plus
  a top-level `metadata` map with pid/cwd/model/tools/sessionName/startedAt.
- Any A2A peer (Pi or not, local or network) can read the session metadata
  directly from the card.
- Live model changes (`model_select` event) refresh the descriptor + card.

### mDNS / DNS-SD (optional dep)

- Broadcast + discover on `_a2a._tcp` for cross-machine LAN discovery.
- `bonjour-service` is an `optionalDependency`, dynamically imported with
  graceful no-op degrade when absent — the zero-dep baseline is preserved.
- TXT record carries url/cwd/model for screening without a card fetch.

### Config

New `a2a.discovery` block in `settings.json`:

```jsonc
"a2a": {
  "discovery": {
    "local": { "enabled": true, "heartbeatSec": 15, "ttlSec": 60 },
    "mdns":  { "enabled": false, "serviceType": "a2a" },
    "enrichCard": true
  }
}
```

New env vars: `A2A_DISCOVERY_LOCAL`, `A2A_DISCOVERY_MDNS`, `A2A_MDNS_TYPE`,
`A2A_HEARTBEAT_SEC`, `A2A_TTL_SEC`, `A2A_ENRICH_CARD`.

### Tests

109 → 141 (registry GC, card enrichment, discovery merge/dedupe, mDNS handle,
mdnsPeerKey dedup, clean/sanitization, self-exclusion, server
register/unregister lifecycle, local-disabled).

### Review-hardened (post-review fixes)

- **mDNS unbounded growth fixed** — added `down` handler + composite dedup key
  (`mdnsPeerKey`) so URL-less peers don't accumulate and departed peers are
  removed.
- **Prompt-injection defense** — discovery fields (name/cwd/tools) from
  untrusted sources (mDNS TXT, registry files) are sanitized via `clean()`
  (single-line, length-capped) before rendering to the model.
- **mDNS independent of local** — `startDiscovery` no longer gated behind
  `local.enabled`; descriptor built unconditionally so mDNS works standalone.
- **Self-exclusion** — `listPeers` accepts `selfUrl` so a session doesn't see
  itself as a delegation target.
- **Defensive `cfg.peers ?? {}`** in `listPeers` for hand-built configs.
- Validated with a live two-session mutual-discovery smoke test.

### Security hardening (second review round)

- **Credential exfiltration fixed (HIGH)** — the shared bearer token is now
  attached to loopback URLs ONLY when the URL is a *known* peer (configured
  `a2a.peers` or a live local-registry entry — same machine, same user). An
  arbitrary/prompt-injected `a2a_call("http://localhost:<port>")` sends NO
  Authorization header. mDNS peers are excluded (network-controllable).
- **IPv6 `::1` loopback** — `isLoopbackHost` now strips brackets before
  comparison (consistent with `isPrivateHost`), so `http://[::1]:port` works.
- `normUrl` exported from config (shared by resolvePeer + known-peer matching).
- Tests: 141 → 146 (known-loopback token attach, arbitrary-loopback no-token,
  non-loopback no-token, no-token-configured, IPv6 ::1).
- Live validation: `a2a_call` to a discovered registry peer (9911) succeeds
  with auto-attached token; arbitrary localhost port receives no token.

### Per-session identity (third round)

- **Unique caller attribution** — new `selfIdentity` config (env
  `A2A_SELF_IDENTITY`) names THIS session. When set, the outbound path presents
  `peerTokens[selfIdentity]` instead of the shared token, so the receiver's
  `authenticate()` attributes the call to a named session (not the anonymous
  `ip:` identity). Fixes the all-sessions-share-one-token problem: unique audit
  entries, per-session rate-limit buckets, and real `trustedPeers` allow-lists.
- Falls back to the shared token when `selfIdentity` is unset or has no
  `peerTokens` entry — backward compatible.
- The session descriptor + Agent Card now carry `selfIdentity` so peers know
  which token to present when calling this session.
- Sessions still reach each other: each presents its OWN token; the receiver's
  global `peerTokens` directory resolves the identity. No caller needs another
  session's token.
- Tests: 146 → 149 (own-token preference, shared fallback when identity absent,
  shared fallback when selfIdentity empty).

## 0.1.1 — 2026-08-13

Fix: A2A inbound server EADDRINUSE across concurrent Pi sessions.

- **Port fallback**: when the configured `a2a.server.port` is busy (another Pi
  session holds it), the inbound server now climbs to `port+1` … `port+10`
  (configurable via `a2a.server.portFallback` / `A2A_PORT_FALLBACK`), then
  falls back to an OS-assigned port — instead of failing with
  `listen EADDRINUSE: address already in use`.
- **Accurate Agent Card**: the card advertises the port the server *actually*
  bound, so peers can always call it back after a fallback.
- **Non-fatal auto-start**: `session_start` no longer shows a scary error toast
  when inbound serving can't start; it warns once and outbound `a2a_*` tools
  keep working.
- **Ephemeral port (0)**: explicit `a2a.server.port: 0` binds an OS-assigned
  port with no misleading "port was busy" note.
- **Stopped state**: `server.url` returns empty / `server.port` null after
  stop — no stale-port advertisement.
- **Docs**: README notes `a2a.server.enabled` is per-session; prefer
  project-local `.pi/settings.json` for a fixed port.
- Tests: 104 → 109 (fallback-to-next-port, OS-assigned exhaustion, card
  advertises real port, happy-path, explicit ephemeral port 0, empty url after
  stop). Typecheck clean.

## 0.1.0 — 2026-08-13

Initial release. A2A Protocol v1.0 bidirectional extension for the Pi coding agent.

**Review-hardened**: 3 adversarial review rounds (20 findings total, all fixed).
104 tests passing, clean typecheck, clean pack. Live interop verified against a
running Hermes A2A server (discover + call → reply).

### Outbound (always available)

Pi as an A2A Client — discover and delegate tasks to remote agents (Hermes,
Google ADK, LangChain, CrewAI, any A2A-compliant peer):

- **Tools:** `a2a_call`, `a2a_discover`, `a2a_list`, `a2a_history`, `a2a_orchestrate`
- **Commands:** `/a2a-discover`, `/a2a-agents`, `/a2a-send`, `/a2a-broadcast`,
  `/a2a-status`, `/a2a-config`, `/a2a-help`
- Multi-turn conversations via `context_id` (persisted to JSONL, survives
  compaction/restart)
- Capability-based fan-out (`a2a_orchestrate`): `all` / `first` / `best` modes

### Inbound (opt-in via `a2a.server.enabled`, default off)

Pi as an A2A Server — exposes itself as an A2A-discoverable agent:

- Agent Card at `GET /.well-known/agent-card.json` (legacy `agent.json` alias)
- JSON-RPC v1.0 methods: `message/send`, `message/stream` (SSE), `tasks/get`,
  `tasks/list`, `tasks/cancel`, `tasks/subscribe`; pre-1.0 path aliases accepted
- Each inbound task spawns an isolated Pi agent session (`createAgentSession`)
  in the configured workspace and returns the reply as a task artifact
- **Command:** `/a2a-server start|stop|status`

### Security (ported from Hermes)

- **Localhost-only by default** — remote exposure requires a token AND an
  explicit `a2a.server.host` opt-in
- Per-peer tokens (`A2A_PEER_TOKENS`) or shared bearer (`A2A_BEARER_TOKEN`)
- Constant-time token comparison; authenticated identity drives trust/rate-limiting
- **Outbound redaction** — credential-shaped strings (API keys, JWTs, bearer
  tokens, emails) scrubbed before sending to peers
- **Inbound injection filtering** — ChatML / role-prefix / override phrases
  defanged; inbound text framed as untrusted peer input
- Audit log (`<piDir>/a2a_audit.jsonl`); anti-loop turn cap per context

### Implementation

- Zero runtime dependencies — pure Node.js stdlib + global `fetch`
- A2A v1.0 wire format, tolerant of v0.3 peers (legacy `kind` Parts, `agent.json`)
- TypeScript extension, 90 mocha + tsx tests, clean typecheck
