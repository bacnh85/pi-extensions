---
name: a2a
description: A2A (Agent2Agent) Protocol v1.0 bidirectional communication. Distribute tasks to remote agents (Hermes, ADK, LangChain, CrewAI, any A2A peer) and be called by them. Use when delegating work across agents/machines/frameworks, doing parallel multi-agent fan-out, or when another agent needs to call Pi. Trigger on "a2a", "agent-to-agent", "delegate to another agent", "ask agent X", "call remote agent", "multi-agent", "Hermes", "task distribution".
---

# A2A — Agent-to-Agent Protocol v1.0

Pi as a first-class A2A peer. [A2A](https://a2a-protocol.org) is the open
Linux Foundation standard for inter-agent communication (JSON-RPC 2.0 over
HTTP). This extension makes Pi bidirectional: it can **call other agents** and
**be called by them**.

## When to use

- **Delegating to a specialist** — a peer advertising `web_search`/`research`/
  `coding` skills can be discovered and called mid-conversation.
- **Cross-machine collaboration** — hand a task to a Hermes on a server, each
  with its own memory/tools/credentials.
- **Parallel fan-out** — send one task to every capable peer at once.
- **Being callable** — expose Pi so other frameworks' agents can send it tasks.

For same-machine, in-process delegation (cheaper, shared context) prefer the
`subagent` tool. A2A is for crossing process/machine/framework boundaries.

## Outbound — calling other agents (5 tools)

| Tool | Use |
|------|-----|
| `a2a_discover(url)` | Fetch a peer's Agent Card to learn its capabilities |
| `a2a_call(agent, message, context_id?)` | Send a task, get the reply; reuse `context_id` for multi-turn |
| `a2a_list()` | Configured peers, persisted conversations, metrics |
| `a2a_history(context_id)` | Recall a persisted conversation |
| `a2a_orchestrate(capability, message, mode?)` | Fan-out to all peers advertising a capability (`all`/`first`/`best`) |

`agent` is a configured peer name (from `a2a.peers` in settings.json) OR a full
`http(s)://` URL.

## Inbound — being callable (opt-in)

`/a2a-server start` serves an Agent Card + JSON-RPC endpoint. Each inbound task
spawns an isolated Pi agent session in the workspace and returns the reply as a
task artifact. **Localhost-only by default**; remote needs a token + explicit host.

## Commands

`/a2a-discover <url>` · `/a2a-agents` · `/a2a-send <agent> <msg>` ·
`/a2a-broadcast <msg> --agents a,b,c` · `/a2a-status` · `/a2a-config` ·
`/a2a-server start|stop|status` · `/a2a-help`

## Security (on by default)

- No token ⇒ localhost-only bind; remote requires token + explicit host.
- Outbound text is scrubbed of credentials; inbound text is injection-filtered
  and framed as untrusted peer input.
- Per-context anti-loop cap; append-only audit log at `<piDir>/a2a_audit.jsonl`.

## Configuration

Peers and server live under the `a2a` key in `~/.pi/agent/settings.json`, or
`A2A_*` env vars. See the package README for the full schema.
