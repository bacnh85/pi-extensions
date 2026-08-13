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
pi install github:bacnh85/pi-extensions/pi-a2a
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

Edit `~/.pi/agent/settings.json` under the `a2a` key:

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
      "agentName": "pi",
      "skills": [
        { "id": "coding", "name": "coding",
          "description": "Read, edit, run, debug, refactor, test",
          "tags": ["coding"] }
      ]
    },
    "timeouts": { "send": 120000, "async": 30000, "stream": 120000 }
  }
}
```

Peers can also be addressed by direct URL (no config needed): `a2a_call` with
`agent: "http://host:port"` works.

### Multiple Pi sessions (port fallback)

`a2a.server.enabled: true` is **per-session** — every Pi session with it enabled
starts its own inbound server. With a **global** setting, the first session
binds the configured port; subsequent sessions hit `EADDRINUSE` and
automatically **climb to the next free port** (`port+1` … `port+10`, then an
OS-assigned port), so they start cleanly instead of failing. Each session's
Agent Card advertises the port it actually bound, so peers can always call it
back.

To avoid surprise ports, prefer setting `a2a.server.enabled` in a **project-local**
`.pi/settings.json` (one project = one inbound server on the fixed port) rather
than globally. `portFallback: 0` means "configured port only, straight to
OS-assigned on conflict".

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
| `A2A_REPLY_TIMEOUT` | `300` | Seconds to wait for the agent's reply |
| `A2A_SERVER_ENABLED` | `false` | Auto-start the inbound server on session start |

## Tools

| Tool | What it does |
|------|--------------|
| `a2a_call(agent, message, context_id?)` | Send a task to a peer, return its reply; multi-turn via `context_id` |
| `a2a_discover(url)` | Fetch and summarize a peer's Agent Card |
| `a2a_list()` | Configured peers, persisted conversations, metrics |
| `a2a_history(context_id, limit?)` | Recall a persisted conversation |
| `a2a_orchestrate(capability, message, mode?)` | Fan-out to all peers advertising a capability (`all`/`first`/`best`) |

## Commands

| Command | Description |
|---------|-------------|
| `/a2a-discover <url>` | Fetch an agent's Agent Card |
| `/a2a-agents` | List configured peers |
| `/a2a-send <agent> <msg>` | Send a task to a peer |
| `/a2a-broadcast <msg> --agents a,b,c` | Parallel fan-out to listed agents |
| `/a2a-status` | Metrics + server status |
| `/a2a-config` | Show current config |
| `/a2a-server start\|stop\|status` | Manage the inbound server |
| `/a2a-help` | Show help |

## Security model

**Secure by default; every widening step is explicit.**

- **No token ⇒ localhost only.** The inbound server binds `127.0.0.1`. Remote
  exposure requires a bearer token **and** an explicit `a2a.server.host`.
- **Per-peer tokens** (`A2A_PEER_TOKENS="alice:tok1,bob:tok2"`) give each peer
  its own credential; the authenticated name drives rate limiting and trust.
- **Prompt-injection filtering** — inbound text is defanged and framed as
  untrusted peer input. Remote peers cannot invoke operator slash commands.
- **Outbound redaction** — credential-shaped strings (API keys, JWTs, tokens,
  emails) are scrubbed from replies before they leave.
- **Audit log** — every exchange appends to `<piDir>/a2a_audit.jsonl`.
- **Anti-loop** — per-context turn caps stop two agents ping-ponging forever.

## Inbound: isolated sessions, not the live TUI

Pi has no platform-adapter API, so an inbound A2A task spawns an **isolated Pi
agent session** (`createAgentSession`) in the configured workspace, runs it to
completion, and returns the reply as a task artifact. The caller gets a
reproducible, tool-equipped agent invocation in your repo — not the interactive
TUI session. This is the correct boundary for a coding agent (and the same
proven path `pi-subagent` uses).

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

Implements the A2A Protocol v1.0 JSON-RPC binding:

| Feature | Status |
|---------|--------|
| Agent Card (`/.well-known/agent-card.json`) | ✅ + legacy `agent.json` |
| `message/send` (sync) | ✅ |
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
npm test         # mocha + tsx (90 tests)
npm run typecheck
npm pack --dry-run
```

## License

MIT
