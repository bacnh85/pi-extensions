# Changelog

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
