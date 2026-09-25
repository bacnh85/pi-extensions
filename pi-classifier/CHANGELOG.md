# Changelog

## 0.2.0 (2026-09-25)

- **Plan gate for pi-plan** (`planGateVerdict` export + `classifier.planGate` config block, default OFF): when pi-plan's plan-mode confirm tier fires, Jev is asked whether the command is read-only and needed for planning; a confident yes auto-allows in enforce mode, every other outcome — disabled, risky-list command, low score, HTTP error, timeout, malformed noul — falls back to pi-plan's normal prompt. Jev may only reduce prompts, never unlock a write and never deny. Verdicts cached by command+cwd store confidence (not the allow decision), so a mid-session observe→enforce flip applies to cached verdicts; every verdict audited with `source: "plan-gate"`. The package now declares `main`/`exports` so pi-plan can import it as a library.
- `/classifier-config` command — interactive panel (pi-config-panel kernel) covering every setting: baseUrl, decision model (with completions pulled from the router's `GET /v1/systemone/models`), the permission auto-approve block (enabled / enforce-vs-observe / threshold) and the plan-mode gate block (enabled / enforce-vs-observe / threshold); `show` fallback prints config + discovered models in non-TUI mode.
- **Zero-config defaults (pi-subagent pattern)**: on a fresh install the panel renders configured — `classifier.baseUrl` falls back to the configured `router.baseUrl` (same yardmaster serves both wires) and the API key falls back to the auth.json `router` credential, but only while classifier.baseUrl is unset or shares the router's host (the router key never silently follows classifier.baseUrl to a third-party endpoint). Explicit `classifier.*` settings always win.
- Decision-model discovery: `listDecisionModels()` fails open (`[]`) on 404/error so OpenRouter-direct and TypeSafe-direct endpoints keep manual model entry.
- `writeClassifierSection()` — atomic read-modify-write of the global settings.json `classifier` section (corrupt file → throw, never clobber).
- Fix: the `classify` tool never resolved the API key (env/auth.json) — every tool call failed with "classifier API key not configured" unless the permission hook was enabled; it now sends the key and honors abort signals.
- New runtime dependency `@bacnh85/pi-config-panel` (static top-level import — the repo-standard pattern; a dynamic `import()` in the handler breaks under Pi's jiti loader with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); test runner switched to `node --import tsx --test` (panel kernel is TypeScript).
- **Permission auto-approve defaults to ON/enforce** (owner decision after a 102-verdict live audit with zero dangerous approvals): reversible, task-serving shell commands skip the prompt without any configuration. The gate is a no-op until a baseUrl+API key resolve (zero-config router fallback counts), every failure falls back to the normal prompt, the static risky list is a hard floor, and explicit `permission.enabled: false` in settings.json opts out.

## 0.1.0 (2026-09-12)

- Initial release: `classify` tool (noul/choice/score) + opt-in Jev-gated permission auto-approve hook (static risky list, observe/enforce modes, LRU verdict cache, audit log).
