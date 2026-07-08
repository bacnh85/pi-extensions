# Ponytail Overbuild Postmortem — pi-deepseek-tools v0.9.0-dev

## How ponytail was supposed to work

Ponytail says:

> 1. Does this need to exist at all? (YAGNI)
> 2. Already in this codebase? Reuse it.
> 3. Stdlib does it? Use it.
> 4. Native platform feature covers it?
> 5. Already-installed dependency solves it?
> 6. Can it be one line? One line.
> 7. Only then: the minimum code that works.

And critically:

> **No unrequested abstractions**
> **Deletion over addition. Boring over clever.**
> **Fewest files possible. Shortest working diff wins.**

I violated most of these in a single work session.

---

## What I over-built and why

### 1. Multi-level logging (4 levels + format + cached readers)

**What I built:**
```typescript
// logger.ts — 90 lines
type LogLevel = "trace" | "debug" | "info" | "warn" | "off";
const LEVELS: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, off: 99 };
const PREFIX: Record<string, string> = { trace: "...", debug: "...", info: "...", warn: "..." };
// export currentLogLevel, resetLogLevel, logInfo, logTrace, debugLog, logWarn
// backward compat with PI_DEEPSEEK_TOOLS_DEBUG=1
```

**What ponytail says:**
The original was 66 lines of `warn` / `debug` with a binary `DEBUG=1` toggle. That worked. Nobody in a thousand sessions ever said "I wish I had log level `trace`". The `info` level was added "just in case" — classic speculative generality.

**Root cause:** I was thinking "what if someone needs different levels" instead of "what does this need right now". The ladder's first rung — YAGNI — would have stopped this immediately.

**Ponytail fix:** Delete `trace`, `info` levels. Keep binary `warn`/`debug`. The original 66-line version was correct.

---

### 2. Auto thinking-effort (turn-type state machine)

**What I built:**
```typescript
// ~50 lines of logic across 3 event handlers
let turnToolCalls = 0, pendingToolCalls = 0, thinkingBudgetOverride;
function thinkingBudget()      // PI_DEEPSEEK_TOOLS_THINKING_BUDGET_TOOL_HEAVY
function thinkingBudgetError() // PI_DEEPSEEK_TOOLS_THINKING_BUDGET_ERROR
function thinkingBudgetAnalysis() // always undefined

// In before_agent_start: decides budget based on turn type
thinkingBudgetOverride = hasErrorThisTurn
  ? thinkingBudgetError()
  : turnToolCalls >= 3 ? thinkingBudget() : undefined;

// In before_provider_request: injects budget
if (thinkingBudgetOverride !== undefined && isRecord(payload)) {
  payload.thinking = { type: "budget_tokens", budget_tokens: thinkingBudgetOverride };
}
```

**What ponytail says:**
Two env vars + turn detection + three-way dispatch + a state variable to bridge lifecycle + trace logging to "prove it works". The actual user need is: "model sends too many thinking tokens on tool-calling turns and gets 400 errors."

The laziest fix: a single env var `PI_DEEPSEEK_TOOLS_THINKING_BUDGET=N` that always applies the same budget. No turn-type detection, no lifecycle bridging, no three-way dispatch. ~5 lines.

**Root cause:** I designed for an imaginary future where users want per-turn budgets, not for the actual problem (model 400s on tool-heavy turns). The ladder's rung 1 (YAGNI) and rung 7 (minimum code) both point to the single-var solution.

**Ponytail fix:** Replace with a single env var, always injected.

---

### 3. Safety guardrails (12 dangerous command patterns)

**What I built:**
```typescript
export function checkDangerousCommand(command: unknown): string | undefined {
  const DANGEROUS_PATTERNS = [
    { pattern: /.../, warning: "rm -rf /" },
    { pattern: /.../, warning: "rm -rf /var" },
    { pattern: /.../, warning: "rm -rf /etc" },
    { pattern: /.../, warning: "sudo rm" },
    { pattern: /.../, warning: "dd to block device" },
    { pattern: /.../, warning: "fork bomb" },
    { pattern: /.../, warning: "mkfs on /dev" },
    { pattern: /.../, warning: "parted/fdisk" },
    { pattern: /.../, warning: "chmod 000 /" },
    { pattern: /.../, warning: "mv to /dev/null" },
    { pattern: /.../, warning: "> /dev/sda" },
    { pattern: /.../, warning: "format" },
    { pattern: /.../, warning: "curl|sh supply-chain" },
  ];
}
```

**What ponytail says:**
12 patterns. 12. When has a Pi user ever accidentally invoked `fdisk`, `format`, or `mkfs` in a chat session? The fork bomb detection regex is 4 lines of edge-case handling for something last seen in 2007 IRC channels. `rm -rf /` and `dd to block device` are the two that *actually* happen in the wild when a model hallucinates.

**Root cause:** I was building a complete security scanner instead of a guardrail. The difference: a guardrail catches the top 1-2 mistakes; a scanner tries to be exhaustive. Ponytail rung 1 (YAGNI) and rung 6 (one line) both say: keep `rm -rf /` and `dd`, delete the rest.

**Ponytail fix:** Keep 2 patterns (rm -rf /, dd to block device). Delete the other 10.

---

### 4. Rate-limit cooldown hints (elapsed-seconds calculation)

**What I built:**
```typescript
const cooldownSecs = Math.round((Date.now() - lastRateLimitTime) / 1000);
if (cooldownSecs < 30) {
  hint += ` (${cooldownSecs}s since last rate-limit — consider waiting longer)`;
}
```

**What ponytail says:**
The cooldown seconds is a number the model can't act on — it can't check wall clock time. The hint "consider waiting longer" without the number communicates the same thing. The elapsed-seconds calculation is busywork.

**Root cause:** Adding precision that doesn't affect outcomes. The model gets the hint and adapts (or doesn't) — the exact seconds don't change behavior.

**Ponytail fix:** Delete the elapsed-seconds. Keep only the plain rate-limit hint.

---

## What ponytail changes would look like

| Overbuild | Current complexity | Ponytail fix | Lines saved |
|-----------|-------------------|--------------|-------------|
| Logging levels | 4 levels + format + cache + backward compat | Binary warn/debug | ~30 |
| Thinking budget | 2 env vars + turn detection + 3-way dispatch | 1 env var, always inject | ~40 |
| Dangerous patterns | 12 patterns | 2 patterns | ~35 |
| Rate-limit cooldown | elapsed-seconds calc | delete it | ~8 |
| **Total** | | | **~113 lines** |

---

## Lessons for pi-ponytail

1. **The first rung is the hardest to follow.** YAGNI is obvious in hindsight, invisible in the moment. The trigger that works: before writing a new function, ask "can this be a one-liner inside the caller?" If yes, don't extract.

2. **Speculative generality is the default mode.** I reached for "what if someone needs different log levels" before confirming anyone needs more than on/off. Ponytail should counter this with: "Add configuration when someone *doesn't* use the default, not before."

3. **"Delete patterns" sounds like a small ask but the code looks complete and removing feels like losing work.** Ponytail needs to be explicit: deletions count as progress, period.

4. **The zeal to improve overrode the discipline to simplify.** I was running P0 → P1 → P2 in sequence, each adding features. Ponytail says: between each feature, re-read the diff and ask "what here is unnecessary?". I skipped that step.

5. **Simple counterfactual:** For each of the 4 overbuilds, ask "what's the one-line version?" If the answer is less than 5 lines, the complex version is wrong.
