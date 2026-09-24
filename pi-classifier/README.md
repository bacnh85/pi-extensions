# pi-classifier

System One decision models ([TypeSafe Jev](https://docs.typesafe.ai/)) for
[Pi](https://pi.dev). Jev returns typed answers with calibrated probabilities —
never text — so this extension surfaces it as a **tool**, not a model.

Two pieces:

1. **`classify` tool** — the agent sends `{state, questions}`, gets typed
   answers: `noul` (P(yes)), `choice` (option + probabilities + confidence),
   `score` (weighted position + confidence). Use for routing, verification,
   and gating decisions.
2. **Opt-in permission auto-approve hook** — shell commands Jev is confident
   are *reversible* and *serve the task* run without prompting. [The OpenRouter
   cookbook pattern](https://openrouter.ai/docs/cookbook/coding-agents/auto-approve-permission-prompts-with-jev).

## Install

```bash
pi install @bacnh85/pi-classifier
```

## Configure

Global settings only (`~/.pi/agent/settings.json`) — never repo scope, because
the endpoint receives your API key as Bearer:

```jsonc
{
  "classifier": {
    "baseUrl": "http://localhost:8787/v1",  // yardmaster (or https://openrouter.ai/api)
    "model": "jev/jev-latest",              // id the upstream knows: jev/jev-latest, or/typesafe/jev-1.13, jev-latest…
    "permission": {                          // opt-in — default OFF
      "enabled": true,
      "mode": "observe",                     // start here; "enforce" to act
      "threshold": 0.9                       // both nouls must clear it
    }
  }
}
```

API key: `CLASSIFIER_API_KEY` env, or the `classifier` credential in
`~/.pi/agent/auth.json`:

```json
{ "classifier": { "key": "ar-..." } }
```

Through [yardmaster](https://github.com/bacnh85/yardmaster): point `baseUrl`
at the router's `/v1`, set `model` to the prefixed id (`jev/jev-latest` for
the TypeSafe-direct provider, `or/typesafe/jev-1.13` via OpenRouter) and use
your router key. Pricing: $0.042/Mtok input, output free.

## The safety envelope

Non-negotiables, in order:

1. **Static risky list first.** `rm -rf`, `sudo`, force-push/hard-reset,
   pipe-to-shell, publish/deploy CLIs, credential paths → never sent to Jev,
   never auto-approved. The list is deliberately short and shallow.
2. **Never auto-denies.** Any outcome other than a confident yes (low score,
   timeout, 4xx/5xx, malformed answer, missing key, no UI) falls back to the
   normal prompt. Worst case is one extra prompt, never an unwanted command.
3. **Observe mode.** The default posture logs the decision it *would* have
   made to `~/.pi/agent/classifier.log` without acting. Run it for a few
   days, read the log, then flip `mode: "enforce"`.
4. **One audit line per decision** — command, scores, elapsed ms, model.
5. **Compound commands are split** on operators before the risky check; a
   separator hidden inside quotes can only add a prompt, never hide a command.

Host deny rules always win: pi-classifier only ever *allows*; it cannot
override an explicit deny from pi-permission or the harness.

## Verification cache

Verdicts are cached (LRU, 100 entries) keyed by command + cwd, so repeated
`bun test` doesn't re-pay Jev or add latency every time.

## Using the classify tool directly

Ask the agent: *"Classify this ticket: is_urgent noul, team choice
(billing/technical/account), severity score 0-3"* — it composes the questions
and returns the typed answers. Questions run in parallel inside one request;
probabilities jitter ±0.08 between identical calls, so thresholds are policy —
tune them on your own traffic.

## Coexistence with pi-permission

Both observe `tool_call`. pi-classifier's silent-allow and pi-permission's
`ask` compose by load order: whichever extension returns first wins. If you
run both, the intended stack is pi-permission `deny` rules (they win over
everything) + pi-classifier enforce for the confident middle. Test the
combination before trusting it.
