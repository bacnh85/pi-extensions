# @bacnh85/pi-evolve

Trajectory-based **self-learning loop** for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent): automatically captures tool-call trajectories, reflects on them to extract transferable learnings, persists them, and injects recent learnings into future sessions.

> *pi-munin remembers. **pi-evolve** learns.*

This is the **active half** of agent self-improvement. [pi-munin](../pi-munin) is a passive memory store (the agent must decide to search and store); pi-evolve closes the loop — **capture → reflect → consolidate → inject** — that runs automatically on every turn.

## How it works

```
CAPTURE (automatic, hooks)             REFLECT (agent tool)
  tool_call  → record tool + input       evolve_reflect returns the sealed
  tool_result → mark ok/err + category    trajectory + a prompt skeleton;
  turn_end   → record usage               the model extracts 0-3 learnings.
  agent_end  → seal snapshot                          │
                                                       ▼
CONSOLIDATE (agent tool)            INJECT (automatic, session start)
  evolve_save → Munin (type:learning)   before_agent_start prepends a
                or .pi/evolve/            "Recent Learnings" digest (last N)
                learnings.jsonl           + the pi-evolve usage header.
```

## Install

```
pi install npm:@bacnh85/pi-evolve
```

## Tools

| Tool | Description |
|------|-------------|
| `evolve_reflect` | Extract transferable learnings from the recent trajectory. Returns the sealed snapshot + a prompt skeleton for the model to produce 0-3 structured learnings (`strategy`/`recovery`/`optimization`). |
| `evolve_save` | Persist a learning to Munin (tag `type:learning`) or local JSONL. |

## Commands

- `/evolve` — show buffer size, last seal, learnings written this session, active store backend.

## Configuration

Optional `evolve` key in `settings.json`:

```json
{
  "evolve": {
    "enabled": true,
    "autoInject": true,
    "maxInject": 3,
    "store": "auto",
    "bufferCap": 200,
    "localCap": 500
  }
}
```

| key | default | meaning |
|-----|---------|---------|
| `enabled` | `true` | master switch for capture + inject |
| `autoInject` | `true` | prepend learnings digest at session start |
| `injectMode` | `"both"` | `recent` \| `similar` \| `both` — similar = search by the user prompt; both = similar first, recent fallback (v0.2) |
| `maxInject` | `3` | max learnings in the digest |
| `store` | `"auto"` | `munin` \| `local` \| `auto` (munin if configured, else local) |
| `bufferCap` | `200` | max in-memory trajectory entries |
| `localCap` | `500` | max JSONL entries (bounded at append) |
| `autoReflect` | `true` | nudge at `agent_end` when a recovery pattern is detected (v0.2) |

## Storage backends

- **Munin configured** (`MUNIN_API_KEY` + `MUNIN_PROJECT` set via env or `.env.local`) → learnings stored with tag `type:learning,domain:<inferred>`, searchable via `munin_search`.
- **Munin not configured** → local JSONL at `.pi/evolve/learnings.jsonl` (capped at `localCap`).

## Safety

- Input digests are **truncated to 200 chars and redacted** (API keys, tokens, Bearer headers, long base64 blobs → `[REDACTED]`) before reaching the buffer.
- The trajectory buffer is **in-memory only**; sealed snapshots are short-lived.
- Injection is **best-effort** — a read failure never breaks a session.

## Design references

Implements the *Trajectory-Informed Memory Generation* pattern (arXiv:2603.10600) within the *Scaffolding Improvement / Memory* axis of the self-improving-agents taxonomy (arXiv:2607.13104, [awesome-Self-Improving-Agents](https://github.com/selfimproving-agent/awesome-Self-Improving-Agents)). Scope is the pragmatic trajectory loop; DGM-style recursive self-modification (arXiv:2505.22954) is out of scope for v0.1.

## Development

```bash
cd pi-evolve && npm test          # mocha + tsx
```

License: MIT.
