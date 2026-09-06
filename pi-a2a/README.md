# @bacnh85/pi-a2a

A2A Protocol v1.0 bidirectional extension for the [Pi coding agent](https://pi.dev/).

Pi becomes a first-class **Agent2Agent** peer: it can **distribute tasks to
remote agents** (Hermes, Google ADK, LangChain, CrewAI, anything A2A-compliant)
and **be called by them**. Follows the upstream
[A2A Protocol v1.0](https://a2a-protocol.org/latest/specification/) — JSON-RPC 2.0
over HTTP, Agent Card discovery, task lifecycle, streaming.

- **Zero runtime dependencies** — pure Node.js stdlib + global `fetch`
- **Outbound** always available; **inbound** opt-in (default off)
- Security model ported from Hermes: localhost-default bind, token-gated
  remote, outbound redaction, inbound injection filtering, audit log, anti-loop

## Install

```bash
pi install npm:@bacnh85/pi-a2a
# or from the monorepo
pi install ./pi-a2a
```

Then `/reload` in Pi.

## Quick start

### Call a remote agent

```bash
# Discover what an agent can do
/a2a-discover http://localhost:9900

# Send it a task
/a2a-send hermes_desktop "Summarize today's arXiv postings on retrieval-augmented generation"
```

Or let the model delegate via the `a2a_call` tool:

> "Ask the researcher agent to summarize today's arXiv postings."

### Be callable by other agents

```bash
/a2a-server start
# → A2A server listening on 127.0.0.1:9910.
#   Agent Card: http://127.0.0.1:9910/.well-known/agent-card.json
```

Other agents can now discover and call Pi:

```bash
curl http://127.0.0.1:9910/.well-known/agent-card.json

curl -X POST http://127.0.0.1:9910/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage",
       "params":{"message":{"messageId":"m1","role":"ROLE_USER",
                 "parts":[{"text":"Find all TODO comments in src/"}]}}}'
```

## Configuration

Edit `~/.pi/agent/settings.json` under the `a2a` key. Key reference:

| Key | Default | Meaning |
|-----|---------|---------|
| `peers` | `{}` | Static peer directory: `name → { url, auth, timeout, capabilities }` |
| `selfIdentity` | `""` | Outbound caller identity — a key in `server.peerTokens` (unique audit attribution) |
| `server.enabled` | `false` | Auto-start the inbound server on session start |
| `server.port` | `9910` | Inbound port |
| `server.portFallback` | `10` | Consecutive ports to try if busy (then OS-assigned) |
| `server.host` | `127.0.0.1` | Bind host (widen to `0.0.0.0` ONLY with a token set) |
| `server.workspace` | cwd | Workspace for inbound isolated sessions |
| `server.agentName` | hostname | Name on the Agent Card |
| `server.publicUrl` | `""` | Externally-routable URL for the Agent Card (reverse proxy / k8s) |
| `server.sharedToken` | `""` | Shared bearer token for the inbound server |
| `server.peerTokens` | `{}` | Per-peer token directory `name → token` (unique identities) |
| `server.trustedPeers` | `[]` | Allow-list of authenticated identities |
| `server.allowAllUsers` | `false` | Allow any authenticated peer (dev only) |
| `server.childTranscripts` | `true` | Persist each dispatched child session's transcript to `<agentDir>/a2a_sessions/<timestamp>_<taskId>.jsonl` (a real pi session file, openable with pi's session tooling) so stalled/killed workers leave a forensic step history. Off = stock in-memory children |
| `server.childTranscriptRetentionDays` | `30` | Delete child transcripts older than N days on server start. `0` = keep forever. Transcripts carry everything the worker read — keep the window bounded |
| `server.maxConcurrent` | `3` | Max concurrent inbound tasks (blocking **and** detached — see the operator note under [Non-blocking dispatch](#non-blocking-dispatch-returnimmediately)) |
| `server.replyTimeoutSec` | `300` | Seconds to wait for the agent's reply on a blocking send. `0` = no reply-window timer (unbounded — the request stays open until the run settles; deliberate, rare) |
| `server.asyncTimeoutSec` | `86400` | Supervision window (seconds) for **detached** tasks sent with `returnImmediately` — the caller's request already returned an ack, so this bound replaces the reply window. `0` = unbounded (caller-supervised via `tasks/get` / `tasks/cancel`) |
| `server.maxPingpongTurns` | `5` | Anti-loop turn cap per context (max 20) |
| `server.rateLimitPerMin` | `60` | Requests/minute per identity |
| `server.skills` | `[]` | Skills advertised on the Agent Card. When empty (default), skills are **self-discovered** from the live session — no config needed |
| `timeouts.send` | `300000` | Outbound send timeout (ms) |
| `timeouts.async` | `30000` | Async task poll interval (ms) |
| `timeouts.stream` | `120000` | Streaming timeout (ms) |
| `retryAttempts` | `2` | Outbound retry count |
| `verifySsl` | `true` | Verify TLS on outbound calls |
| `discovery.local` | `{enabled:true, heartbeatSec:15, ttlSec:60}` | Local file registry |
| `discovery.mdns` | `{enabled:false, serviceType:"a2a"}` | mDNS broadcast + discovery |
| `discovery.gateway` | _(unset)_ | Legacy single upstream a2a-switchboard registration (`enabled`, `url`, `token`, `name`, `upstreamToken`, `heartbeatSec`, `channel`) — see [a2a-switchboard gateway](#a2a-switchboard-gateway) |
| `discovery.gateways` | _(unset)_ | **Multiple** upstream a2a-switchboard gateways (0.6.0): a keyed map `{ <key>: {enabled, url, token, ...} }` — each gateway registers + heartbeats independently; peers appear as `gw/<key>/<name>` |
| `discovery.enrichCard` | `true` | Publish session metadata into the Agent Card |
| `ui.transcript` | `true` | Show inbound activity as transcript messages |

Example:

```jsonc
{
  "a2a": {
    "peers": {
      "hermes_desktop": {
        "url": "http://172.30.55.31:9900",
        "auth": { "type": "bearer", "token": "..." },
        "timeout": 120,
        "capabilities": ["web_search", "research"]
      },
      "researcher": {
        "url": "http://localhost:9999",
        "auth": { "type": "bearer", "token": "..." },
        "capabilities": ["research"]
      }
    },
    "server": {
      "enabled": false,       // set true to auto-start the inbound server
      "port": 9910,
      "portFallback": 10,     // if port is busy (another Pi session), climb to port+1 … +10, then OS-assigned
      "host": "127.0.0.1",    // widen to 0.0.0.0 ONLY with a token set
      "workspace": "",        // defaults to the host session's cwd
      "agentName": "pi"
      // "skills": [...] — optional override; when omitted the card
      // self-discovers the session's loaded skills
    },
    "timeouts": { "send": 300000, "async": 30000, "stream": 120000 }
  }
}
```

Peers can also be addressed by direct URL (no config needed): `a2a_call` with
`agent: "http://host:port"` works. For **loopback** URLs that match a known
peer (configured `a2a.peers` or a live local-registry entry), the session's
shared token is auto-attached so discovered local Pi sessions are callable
without manual per-peer config. Arbitrary loopback URLs never receive the
token (prompt-injection guard).

### Multiple Pi sessions (port fallback)

`a2a.server.enabled: true` is **per-session** — every Pi session with it enabled
starts its own inbound server. With a **global** setting, the first session
binds the configured port; subsequent sessions hit `EADDRINUSE` and
automatically **climb to the next free port** (`port+1` … `port+10`, then an
OS-assigned port), so they start cleanly instead of failing. Each session's
Agent Card advertises the port it actually bound, so peers can always call it
back.

To avoid surprise ports, prefer enabling the server **per project** — via env
(`A2A_SERVER_ENABLED=true` from your shell or the global `~/.pi/agent/.env.local`)
or the global `~/.pi/agent/settings.json` keyed per project. Note: a
**project-local `.pi/settings.json` can no longer enable the server** —
security-relevant keys (`server.enabled`, tokens, host, gateway, …) are ignored
from repo-controlled files, because a checked-out repo must not be able to turn
on an inbound agent server on whoever opens it. (`portFallback: 0` means
"configured port only, straight to OS-assigned on conflict".)

### Environment variables

| Env | Default | Meaning |
|-----|---------|---------|
| `A2A_BEARER_TOKEN` | _(unset)_ | Shared bearer token for the inbound server |
| `A2A_PEER_TOKENS` | _(unset)_ | Per-peer tokens `name:token,...` |
| `A2A_HOST` | `127.0.0.1` | Inbound bind host (only widens with a token set) |
| `A2A_PORT` | `9910` | Inbound port |
| `A2A_PORT_FALLBACK` | `10` | Consecutive ports to try if `A2A_PORT` is busy before OS-assigned |
| `A2A_AGENT_NAME` | hostname | Name on the Agent Card |
| `A2A_PUBLIC_URL` | _(unset)_ | Externally-routable URL for the Agent Card (reverse proxy / k8s) |
| `A2A_TRUSTED_PEERS` | _(unset)_ | Allow-list of authenticated identities |
| `A2A_ALLOW_ALL_USERS` | `false` | Allow any authenticated peer (dev only) |
| `A2A_RATE_LIMIT` | `60` | Requests/minute per identity |
| `A2A_MAX_PINGPONG_TURNS` | `5` | Anti-loop turn cap per context (max 20) |
| `A2A_REPLY_TIMEOUT` | `300` | Seconds to wait for the agent's reply (`0` = unbounded: no reply-window timer) |
| `A2A_ASYNC_TIMEOUT` | `86400` | Detached-task supervision window in seconds (`0` = unbounded) — see [Non-blocking dispatch](#non-blocking-dispatch-returnimmediately) |
| `A2A_SERVER_ENABLED` | `false` | Auto-start the inbound server on session start |
| `A2A_SELF_IDENTITY` | _(unset)_ | Outbound caller identity: a key in `server.peerTokens`. When set, this session presents its OWN per-peer token (not the shared token) so receivers attribute calls to it uniquely. Empty = use the shared token (anonymous caller). |
| `A2A_DISCOVERY_LOCAL` | `true` | Enable the local file registry |
| `A2A_DISCOVERY_MDNS` | `false` | Enable mDNS broadcast + discovery |
| `A2A_MDNS_TYPE` | `a2a` | mDNS service type (advertised as `_<type>._tcp`) |
| `A2A_GATEWAY_URL` | _(unset)_ | Agent-gateway base URL (with `A2A_GATEWAY_TOKEN`) |
| `A2A_GATEWAY_TOKEN` | _(unset)_ | Agent-gateway API/bearer token |
| `A2A_GATEWAY_ENABLED` | _(see gateway)_ | Explicit on/off for gateway registration; defaults to true when url+token are set |
| `A2A_HEARTBEAT_SEC` | `15` | Registry heartbeat interval (seconds) |
| `A2A_TTL_SEC` | `60` | Registry entry TTL before stale-sweep (seconds) |
| `A2A_ENRICH_CARD` | `true` | Publish session metadata into the Agent Card |
| `A2A_UI_TRANSCRIPT` | `true` | Show inbound task activity as transcript messages (false = toasts + footer only) |

### Session discovery (0.2.0)

Each inbound session self-declares its identity so peers can find it **and**
judge whether it's the right delegate (working folder, model, abilities) — no
port-scanning, no manual config. Three layers, all on by default (except mDNS):

1. **Local file registry** (zero-dep) — `<piDir>/a2a_registry/<pid>.json`.
   Instant same-machine discovery with dual stale-GC (mtime TTL + pid liveness
   probe). The proven pattern (VS Code server, Emacs `server`, tmux).
2. **Enriched Agent Card** — the card advertises an A2A v1.0 Extension + a
   `metadata` map with pid/cwd/model/tools. Any A2A peer reads it.
3. **mDNS** (`_a2a._tcp`) — cross-machine LAN discovery. Optional: install
   `bonjour-service` to enable (`npm i bonjour-service`); without it the
   extension degrades to the file registry + card. Each session advertises a
   **unique, pid-suffixed name** (`<hostname>-a2a-<pid>.local`), never the OS
   local hostname — so enabling mDNS cannot make macOS rename the machine
   ("local hostname already in use"). If an earlier 0.3.0 session already
   triggered a rename, restore it: System Settings → General → Sharing, or
   `sudo scutil --set LocalHostName <name>`.

Configure under `a2a.discovery` in `settings.json`:

```jsonc
"a2a": {
  "discovery": {
    "local": { "enabled": true, "heartbeatSec": 15, "ttlSec": 60 },
    "mdns":  { "enabled": false, "serviceType": "a2a" },
    "enrichCard": true
  }
}
```

List discovered peers with the `a2a_peers` tool or `/a2a-peers` command — they
show each peer's name, url, source (`local`/`mdns`/`config`), cwd, model, and
tools so you (or the model) pick the right one before `a2a_call`.

### a2a-switchboard gateway

Register this session with a self-hosted [a2a-switchboard](https://github.com/bacnh85/a2a-switchboard)
so other accepted peers discover and call it through the gateway's proxy
(gateway peers appear as `gw/<key>/<name>` and carry the gateway bearer token).
Configure under `a2a.discovery.gateway` (single) or `a2a.discovery.gateways`
(multiple) in `settings.json` (or the `/a2a-config` panel → Gateway
(discovery.gateway) / Gateways (discovery.gateways) groups; the legacy single-
gateway group is hidden when its block is inert — all-empty + disabled):

```jsonc
"a2a": {
  "discovery": {
    "gateway": {
      "enabled": true,              // explicit on/off; defaults true when url+token set
      "url": "http://127.0.0.1:9920",
      "token": "<gateway-api-token>",
      "name": "pi-s2-9913",          // optional; default <agentName>-<port>
      "upstreamToken": "...",         // optional: token the gateway presents when proxying TO us
      "heartbeatSec": 60,             // re-register interval
      "channel": true                 // reverse channel so firewalled peers can call us
    },
    "gateways": {                     // 0.6.0: multiple gateways
      "work": { "enabled": true, "url": "http://10.0.0.5:9920", "token": "..." },
      "lab":  { "enabled": true, "url": "http://127.0.0.1:9921", "token": "...", "channel": false }
    }
  }
}
```

- Registration is a **per-session** upstream per gateway: each configured
  gateway registers itself, re-registers on heartbeat, and deregisters on
  graceful stop — independently of the others.
- `enabled: false` (or `A2A_GATEWAY_ENABLED=false`) disables registration
  entirely while keeping the url/token for later.
- **Peer naming (0.6.0, breaking):** gateway-proxy peers are ALWAYS prefixed
  with the gateway key — `gw/<key>/<name>`. The single legacy `gateway` block
  uses a key derived from its URL host-port (e.g. `gw/127.0.0.1-9920/<name>`),
  so the old `gw/<name>` names no longer resolve. Use the `gateways` map with a
  stable key if you want predictable names. Add/remove gateways from the
  `/a2a-config` panel (Gateways group).
- The panel renders tokens masked (`••••`); the token is stored in settings.json
  in plaintext (same as `server.sharedToken`) — use env `A2A_GATEWAY_TOKEN` if
  you'd rather keep secrets out of files (env feeds the single `gateway` block).
- **Heartbeat method (PATCH /register):** the first registration with no
  known `caller_token` (first ever, or the state file was lost) is a
  `POST /register` with the shared token — the only path that mints the
  per-peer `caller_token`. Once known, every heartbeat switches to
  `PATCH /register` authenticated as that `caller_token` (full card refresh;
  re-sending the URL covers IP changes). On `405` (old switchboard) or `401`
  (stale token) the heartbeat falls back to POST and the fallback re-mints
  when the response carries a new `caller_token`.

  | Situation | Method | Auth |
  |---|---|---|
  | First register / unknown peer | `POST /register` | shared token |
  | Steady-state heartbeat (`caller_token` known) | `PATCH /register` | `caller_token` |
  | PATCH unsupported (`405`) or rejected (`401`) | `POST /register` | shared token |

  The `caller_token` is disclosed by the gateway **only at mint**, so it is
   persisted per gateway key and peer name at
   `~/.pi/agent/a2a_gateways/<key>/<name>.json` (`{name, callerToken}`) — after
   a restart, heartbeats PATCH immediately instead of re-minting. If both the
   file and caller token are lost while the old peer still exists, delete that
   peer in the switchboard admin UI once, then restart Pi; the next POST mints
   a replacement token.
- The directory fetch (`GET /.well-known/agent.json`) always uses the shared
  token — unchanged by PATCH heartbeats.

### Per-session identity (unique caller attribution)

When all sessions share one `sharedToken`, every caller authenticates as the
SAME anonymous identity (`ip:127.0.0.1`) — the audit log can't tell callers
apart, and the rate-limit bucket is pooled across all local sessions. To give
each session a **unique identity**, add a global `peerTokens` directory and set
this session's self-identity:

```jsonc
"a2a": {
  "selfIdentity": "session-a",          // ← this session presents session-a's token
  "server": {
    "sharedToken": "...fallback...",
    "peerTokens": {                        // ← global directory every session reads
      "session-a": "<tokenA>",
      "session-b": "<tokenB>"
    }
  }
}
```

Or per-terminal via env: `A2A_SELF_IDENTITY=session-a`.

- The token a session presents outbound is `peerTokens[selfIdentity]` (falls
  back to `sharedToken` if unset/absent).
- The receiver matches the presented token against `peerTokens` FIRST, so the
  call is attributed to `session-a` (unique audit entry + separate rate-limit
  bucket). Only tokens NOT in `peerTokens` fall through to the shared identity.
- Sessions still reach each other: A presents `tokenA`, B's server looks it up
  → identity `session-a`; no caller needs anyone else's token.

### Outbound asserted identity (X-A2A-Identity)

Every outbound peer request carries the caller's configured identity
(`selfIdentity`, falling back to `server.agentName`) as an
`X-A2A-Identity` header, in addition to the `pi/self` message metadata. The
use case: when peers live behind a reverse proxy (or on other machines
reached through one), every caller arrives from the proxy's address —
`ip:127.0.0.1` tells the receiver nothing about WHICH agent dispatched. The
header lets a receiving peer's audit log attribute the call to a name
(`pi-kimchi`, `librarian-bingsu`, …) instead of the address.

- **Asserted display provenance, never authentication.** Any client can send
  any name; a receiving server must only use it to refine the display name of
  a caller it has ALREADY admitted (e.g. an authenticated shared-token
  caller), never to grant admission or override a token-authenticated
  identity. Receivers that don't know the header simply ignore it.
- The header is omitted when no identity is configured (both empty).

### Inbound activity in the host TUI (0.3.0)

When a remote peer sends Pi an A2A task, the **host session** now shows what's
happening — you no longer wonder whether Pi is silently doing work:

- **Arrival** — `[A2A inbound] dispatch from <peer>: <preview>` transcript
  message + a toast.
- **Progress** — the isolated session's tool calls and assistant text deltas
  appear as compact one-line transcript messages (`⚙ bash …`, `✎ …`).
- **Completion** — `[A2A inbound] A2A dispatch <label> completed (12.3s) —
  <reply preview>` or `failed: <error>` toast + message. A footer status line
  shows how many inbound dispatches are in flight and from whom.

Protocol task ids are labeled as dispatches (`task-1b4f8d1c30d54819` →
`a2a-1b4`) so a delegated execution reads as one peer-to-peer dispatch, not
a todo-list item; the raw id stays in the audit log. Transcripts written by
older versions say `task from` / `task <id> completed` — same meaning.

Toggle with `a2a.ui.transcript` (default `true`):

```jsonc
"a2a": { "ui": { "transcript": false } }  // toasts + footer only
```

> **Note:** transcript messages are `role: custom` and enter the host agent's
> LLM context as user-role content. They're kept terse and prefixed with
> `[A2A inbound]` so the host agent treats them as informational. Set
> `ui.transcript: false` if you'd rather keep inbound activity out of context
> entirely.

### Interactive config panel (0.3.0)

Stop hand-editing settings.json — run `/a2a-config` in TUI mode to open an
arrow-key panel covering **Server** (enabled, port, host, agent name, reply
 timeout, concurrency, rate limit), **Discovery** (local registry, mDNS,
 enrich-card), **Identity** (selfIdentity), **Peers** (edit URLs, add/remove),
and **UI** (transcript toggle).

- ↑/↓ navigate · Enter toggles/edits · Esc to save/close.
- Saving **persists to settings.json** (preserving all other keys) **and**
  applies live via in-memory overrides — no `/reload` needed.
- Changing server/discovery settings while the inbound server is running
  auto-restarts it.
- `/a2a-config show` prints the plain-text summary (also used in non-TUI
  modes).

## Tools

| Tool | What it does |
|------|--------------|
| `a2a_call(agent, message, context_id?, async_dispatch?)` | Send a task to a peer, return its reply; multi-turn via `context_id`. `async_dispatch: true` returns an ack with the task id immediately (see [Non-blocking dispatch](#non-blocking-dispatch-returnimmediately)) |
| `a2a_status(agent, task_id, wait_seconds?)` | Poll a previously dispatched task by id (GetTask); with `wait_seconds`, poll until terminal or deadline |
| `a2a_discover(url)` | Fetch and summarize a peer's Agent Card |
| `a2a_list()` | Configured peers, persisted conversations, metrics |
| `a2a_history(context_id, limit?)` | Recall a persisted conversation |
| `a2a_orchestrate(capability, message, mode?)` | Fan-out to all peers advertising a capability (`all`/`first`/`best`) |
| `a2a_peers()` | List discoverable peers (local registry + mDNS + configured) with cwd/model/tools |

## Commands

| Command | Description |
|---------|-------------|
| `/a2a-discover <url>` | Fetch an agent's Agent Card |
| `/a2a-agents` | List configured peers |
| `/a2a-send <agent> <msg>` | Send a task to a peer |
| `/a2a-broadcast <msg> --agents a,b,c` | Parallel fan-out to listed agents |
| `/a2a-status` | Metrics + server status |
| `/a2a-config` | Interactive config panel (TUI); `show` for summary |
| `/a2a-server start\|stop\|status` | Manage the inbound server |
| `/a2a-peers` | List discoverable peers (local registry + mDNS + configured) |
| `/a2a-help` | Show help |

## Safety

- **Secure by default; every widening step is explicit.** No token ⇒ the inbound
  server binds `127.0.0.1`; remote exposure requires a bearer token **and** an
  explicit `a2a.server.host`.
- **Per-peer tokens** (`A2A_PEER_TOKENS="alice:tok1,bob:tok2"`) give each peer
  its own credential; the authenticated name drives rate limiting and trust.
- **Token attach is known-peer-only** — outbound calls attach the session token
  ONLY to loopback URLs matching a configured peer or a live local-registry
  entry. Arbitrary/prompt-injected `http://localhost:<port>` URLs never receive
  any credential.
- **Prompt-injection filtering** — inbound text is defanged and framed as
  untrusted peer input. Remote peers cannot invoke operator slash commands.
- **Outbound redaction** — credential-shaped strings (API keys, JWTs, tokens,
  emails) are scrubbed from replies before they leave.
- **Asserted identity is display-only** — the `X-A2A-Identity` header sent
  outbound names the caller for attribution; it is self-reported, carries no
  credential, and must never be trusted for admission on the receiving side.
- **Untrusted metadata sanitized** — mDNS TXT records and registry files are
  network/world-readable input; peer names/cwd/model are sanitized
  (single-line, length-capped) before display.
- **Audit log** — every exchange appends to `<piDir>/a2a_audit.jsonl`.
- **Anti-loop** — per-context turn caps stop two agents ping-ponging forever.

## Inbound: isolated sessions, not the live TUI

Pi has no platform-adapter API, so an inbound A2A task spawns an **isolated Pi
agent session** (`createAgentSession`) in the configured workspace, runs it to
completion, and returns the reply as a task artifact. The caller gets a
reproducible, tool-equipped agent invocation in your repo — not the interactive
TUI session. This is the correct boundary for a coding agent (and the same
proven path `pi-subagent` uses).

The isolated session's activity is **surfaced to the host TUI** as transcript
messages + toasts (see "Inbound activity in the host TUI") — you see what the
inbound task is doing without it running in your live session.

The isolated session runs the **full extension lifecycle**: after creation it
fires `session_start` (via `bindExtensions`, the same thing the SDK's print
mode does), so extensions that wire their tools on session start — e.g.
pi-mcp-extension's MCP servers — are available to the dispatched agent, and
`session_shutdown` is emitted on completion so extension-started processes
are cleaned up. The child never touches the host's own inbound server:
server lifecycle handlers are host-session-only.

Long dispatches run with **auto-compaction enabled** and a keep window scaled
to the model's context window, and the runner waits for the session's
post-run recovery before reporting completion. Without that, a task that
grows near the context window dies misleadingly: pi clamps `max_tokens` to
what remains (down to 1), the model's final turn ends on a length stop with
no text, and the task would otherwise complete with the *previous* turn's
stale reply. Such a turn now fails the task (`FAILED`, status message
"no usable reply was produced") instead of masquerading as success.

## Non-blocking dispatch (returnImmediately)

A blocking `message/send` holds the HTTP request open until the agent finishes
— so the caller's reply window bounds the **worker's** runtime: a long job
(reindex, multi-file refactor, an ops run) gets killed when the caller stops
waiting, even though the caller only wanted to submit it.

A2A v1.0 §3.2.2 `SendMessageConfiguration.returnImmediately` decouples the
two. On the wire it is one extra field:

```jsonc
{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": {
    "message": { "role": "ROLE_USER", "parts": [{ "text": "long job" }] },
    "configuration": { "returnImmediately": true }
  }
}
```

The server acks immediately with the Task in `TASK_STATE_WORKING` and keeps
running it **detached** from the request. The ack no longer waits for the
work; the work no longer dies with the caller's patience. The caller then
polls `tasks/get` (or cancels via `tasks/cancel`) by task id.

From Pi's tools this is `async_dispatch` + `a2a_status`:

```text
a2a_call(agent="worker", message="reindex everything", async_dispatch=true)
# → [A2A → worker · context … · working · detached]
#   Dispatch accepted — task task-1b4f… is running on the peer (non-blocking).
#   Poll the result with a2a_status(agent: "worker", task_id: "task-1b4f…").

a2a_status(agent="worker", task_id="task-1b4f…")          # one fetch
a2a_status(agent="worker", task_id="task-1b4f…", wait_seconds=300)  # poll until terminal
```

- A peer that does not understand `returnImmediately` simply blocks and
  returns the finished task — `a2a_call` falls through to the normal reply
  formatting, so the flag is always safe to send.
- A **fast** task may complete before the ack is serialized; the ack then
  carries the terminal state and artifacts (the client treats it as a normal
  reply — no polling needed).
- Detached runs count against `server.maxConcurrent` exactly like blocking
  ones, and overflow is supervised by `server.asyncTimeoutSec` (default
  24h, `0` = unbounded/caller-supervised) → `TASK_STATE_FAILED` with a
  descriptive status message, mirroring the reply-window semantics.
- **Operator note — a detached run pins a concurrency slot for its whole
  lifetime.** The gate runs *before* the blocking/detached split, and a
  detached run holds its `maxConcurrent` slot from the ack until it reaches
  a terminal state — up to `asyncTimeoutSec` (24h by default) each. Three
  slow or hung detached dispatches at the default `maxConcurrent: 3`
  therefore block **all** inbound work — blocking `message/send` included
  (`server busy`) — until they drain. Levers: keep `asyncTimeoutSec` as low
  as your longest legitimate detached job (it is the kill switch that frees
  the slot), raise `maxConcurrent` if you routinely dispatch long jobs, and
  `tasks/cancel` a stuck task to free its slot immediately. (A separate
  `maxDetached` budget is a plausible follow-up.)
- `returnImmediately` has **no effect on `message/stream`** (per §3.2.2) —
  streaming keeps its blocking semantics.
- The snake_case spelling `return_immediately` is accepted for early
  v1.0-draft clients.

For fleet agents: the natural completion signal is still the shared queue
(knowfleet) — poll `a2a_status` only to surface progress or fetch artifacts,
not as the source of truth for whether the worker finished its bookkeeping.

## Hermes interop

The primary interop target. Hermes (`~/.hermes/hermes-agent`, A2A platform
plugin) implements the same v1.0 wire format bidirectionally, so Pi ↔ Hermes
works out of the box:

```bash
# Discover the local Hermes
/a2a-discover http://localhost:9900

# Send Pi a task FROM Hermes (once /a2a-server start)
# In Hermes: a2a_call("http://<pi-host>:9910", "Find all TODO comments in src/")
```

## Protocol compliance

Implements the A2A Protocol v1.0 JSON-RPC binding. v1.0 method names
(`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
`SubscribeToTask`) speak the v1.0 wire shapes — `SendMessage` replies with the
oneof `{"task": …}` / `{"message": …}` wrapper, streaming emits
`TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent` frames, and `ListTasks`
returns full `Task` objects. The pre-1.0 path aliases (`message/send`,
`message/stream`, `tasks/get`, …) keep the legacy wire shapes (bare `Task`
results, `{id, state}` list stubs) so existing peers see no change.

| Feature | Status |
|---------|--------|
| Agent Card (`/.well-known/agent-card.json`) | ✅ + legacy `agent.json` |
| `message/send` (sync) | ✅ |
| `message/send` non-blocking (`configuration.returnImmediately`) | ✅ (see [Non-blocking dispatch](#non-blocking-dispatch-returnimmediately)) |
| `message/stream` (SSE) | ✅ |
| `tasks/get`, `tasks/list`, `tasks/cancel`, `tasks/subscribe` | ✅ |
| Part types (text, file, data) | ✅ (v1.0 + v0.3 tolerant) |
| Task lifecycle states | ✅ |
| Push notifications | 🔜 (HMAC signing scaffolded) |
| gRPC / HTTP-REST bindings | Not implemented (JSON-RPC only) |

## Development

```bash
cd pi-a2a
npm install
npm test         # mocha + tsx (198 tests)
npm run typecheck
npm pack --dry-run
```

Live mDNS tests are opt-in: `MDNS_NETWORK_TESTS=1 npm test` (they publish
real `_a2a._tcp` records on the local network).

## License

MIT
