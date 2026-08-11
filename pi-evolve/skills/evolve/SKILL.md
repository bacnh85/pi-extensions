---
name: evolve
description: Trajectory-based self-learning loop for Pi. Automatically captures tool-call trajectories, reflects on them to extract transferable learnings (strategy/recovery/optimization), persists to Munin or local JSONL, and injects recent learnings into future sessions. Use evolve_reflect after fixing a bug or recovering from an error; use evolve_save to persist each learning. Triggered when the user mentions self-learning, self-improvement, learning from experience, trajectory analysis, or when a multi-step task reveals a transferable lesson.
---

# pi-evolve

pi-evolve adds an automatic **capture → reflect → consolidate → inject** loop over
your coding-agent sessions. It is the active half of agent self-improvement:
*pi-munin remembers; pi-evolve learns.*

## How it works

```
CAPTURE (automatic, every turn)        REFLECT (agent-called tool)
  tool_call  ─► record tool+input        evolve_reflect returns the
  tool_result ─► mark ok/err + category   sealed trajectory + a prompt
  turn_end   ─► record usage              skeleton; the model produces
  agent_end  ─► seal snapshot             1-3 structured learnings.
                                              │
CONSOLIDATE (via evolve_save)               ▼
  write to Munin (type:learning tag) ◄──── produce learning:
  or local .pi/evolve/learnings.jsonl       {kind, trigger, lesson, anchors}
                                              │
INJECT (automatic, session start)             ▼
  before_agent_start prepends a
  "Recent Learnings" digest (last N)
  + the pi-evolve usage header.
```

## When to reflect

Call `evolve_reflect` when a task reveals a **transferable** lesson:

- **Bug fix** with a non-obvious root cause → `recovery` learning (anchor the fix).
- **Error → retry → success** pattern → `recovery` learning.
- **Successful multi-step workflow** worth repeating → `strategy` learning.
- **Inefficient path discovered** with a better approach → `optimization` learning.

Skip reflection for trivial one-shot work with no recovery or insight. Quality
over quantity — **zero learnings is a valid outcome.**

## Learning kinds

| kind | when | example |
|------|------|---------|
| `strategy` | a successful pattern worth repeating | "Barrel-export from `src/index.ts` for cleaner imports." |
| `recovery` | how an error was diagnosed + fixed | "ECONNREFUSED on `docker compose up` → start the Docker daemon first (`docker info`)." |
| `optimization` | an inefficient path + the better approach | "Reading whole files to find a symbol → use `serena_find_symbol` instead." |

## Quick start

After completing a task that taught you something:

```
evolve_reflect
```

Review the trajectory snapshot it returns, then persist each learning:

```
evolve_save
  kind="recovery"
  trigger="ECONNREFUSED on docker compose up"
  lesson="Start the Docker daemon before compose; verify with `docker info`."
  anchors=["docker-compose.yml","Makefile"]
```

Stored learnings reappear as a **Recent Learnings** digest at the start of
future sessions. Apply one only if its trigger matches the current work.

## Commands

- `/evolve` — show buffer size, last seal, learnings written this session, active store backend.

## Configuration (settings.json `evolve` key, all optional)

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
| `errorTriage` | `true` | master switch for error hints + recall + escalation (v0.3) |
| `recallStoredFixes` | `true` | search stored learnings by error text on error (v0.3, Layer 2) |

## Storage

- **Munin configured** (`MUNIN_API_KEY` + `MUNIN_PROJECT` set) → learnings stored
  with tag `type:learning,domain:<inferred>`, searchable via `munin_search`.
- **Munin not configured** → local JSONL at `.pi/evolve/learnings.jsonl` (capped).

## Safety

- Input digests are **truncated to 200 chars and redacted** (API keys, tokens,
  Bearer headers, long base64 blobs → `[REDACTED]`) before reaching the buffer.
- The buffer is **in-memory only**; sealed snapshots are short-lived.
- Injection is **best-effort** — a read failure never breaks a session.
