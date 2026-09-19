# pi-extensions Security & Robustness Sweep — burn-pi-secvuln-0919 (2026-09-19/20)

Scope: security review of the extension surface at main `fdf44f6` — child-process
spawn/shell-exec paths, path traversal in file-touching tools, secret/token
handling (commandcode tokens, A2A switchboard token readers), SSRF in
web-fetching tools, archive extraction, race conditions on network mounts
(`/Volumes`), prompt-injection-to-exec chains in `web_interact`.

Method: static audit of all 34 packages (grep-driven surface mapping + targeted
reads of the trust-boundary files), one HIGH finding fixed with a test-first
reproduction, remaining items documented as recommendations.

---

## Findings

### HIGH

**H-1 · Outbound redaction never covered the deployment's own configured tokens**
- Files:
  - `pi-a2a/extensions/lib/security.ts` (REDACTION_PATTERNS / `redactOutbound`)
  - `pi-a2a/extensions/lib/server.ts:1079` (reply artifact), `:984` (internal-error
    message), `:1125` (failure message)
  - `pi-a2a/extensions/lib/client.ts:418` (`a2a_send` dispatch body)
- Repro: configure `server.peerTokens.alice = <T>`; an inbound peer asks "what is
  my auth token?"; the worker's reply contains `<T>`; `redactOutbound` matches no
  credential *shape* (tokens are operator-chosen strings), so the reply artifact
  and the JSON-RPC response hand `<T>` back across the trust boundary. Same leak
  path for `server.sharedToken`, `peers[*].auth.token` (bearer/apiKey outbound
  creds), `discovery.gateway.token` and `gateway(s)[*].upstreamToken` when the
  model echoes config or an error string embeds a URL with `:token@`.
- Fix (test-pinned): `collectConfiguredTokens(cfg)` + `redactConfiguredTokens(text, cfg)`
  in `security.ts` (type-only import of `A2AConfig` — no runtime cycle with
  `config.ts`); exact-match redaction, min length 8 (shorter strings are
  collision-prone and must never mangle text), `Set`-deduplicated, tolerant of
  missing config shapes. Chained **before** `redactOutbound` at all four
  outbound sites (send body, reply artifact, internal-error part, failure part).
- Tests: `pi-a2a/extensions/test/security.tokens.test.ts` — 5 cases (all token
  classes, mid-word embedding, integrity for short strings, undefined/empty
  config tolerance, multi-key dedupe). RED state verified before the fix.

### MED (recommendations — behavior unchanged on this branch)

**M-1 · `web_interact` prompt-injection-to-exec exposure is design-inherent**
- `pi-web/extensions/lib/cdp.ts:228-257`, `pi-web/extensions/index.ts:534-560`.
  Auto-dismiss of native dialogs (e0f76047) closes the *casual* accept chain, and
  a `dialog` step requires an explicit tool argument, which is good. But any
  model that has already decided to `click` is executing trusted CDP activation
  on attacker-influenced page content; `evaluate` remains arbitrary JS in the
  page origin (by design, local Chrome only — no remote-debug port exposure).
  Residual risk is prompt-injection convincing the model to arm
  `{"dialog":"accept"}` before a destructive click. Mitigation direction
  (non-trivial): per-origin tool-level allowlists, or a user-visible confirm
  hook on `dialog:"accept"`. Not fixable surgically without changing tool
  semantics; deferred deliberately.

**M-2 · `pi-model-tools` `apply_patch` honors absolute paths by design**
- `pi-model-tools/extensions/lib/apply-patch.ts:300-336`
  (`resolvePathLikePi`). Mirrors pi core `resolveToCwd` semantics; the real
  boundary is pi's permission system (external-directory deny), so this is a
  documented pass-through, not an independent hole. Recommendation: an
  optional workspace-root clamp for unattended/agent-fleet profiles.

**M-3 · `/Volumes` network-mount races remain at the OS layer**
- `pi-obsidian` already routes write verification through the CLI on network
  mounts (9e6ec7f). `pi-attachments` paste-save and `pi-notebooklm` temp
  staging degrade gracefully on EACCES/ENOSPC (try/catch pass-through). No
  unhandled-mount write path found; keep the pattern for future packages.

### LOW

**L-1 · `pi-a2a` audit log stores a 300-char preview unredacted**
- `pi-a2a/extensions/lib/security.ts` `audit()` — previews are forensically
  useful but could contain token echoes; they now stay local (never leave the
  machine), but consider `redactConfiguredTokens` on the preview too.

**L-2 · Windows `taskkill` path falls back to `C:\Windows`**
- `pi-windows-tools/extensions/lib/shell-exec.ts` `stop()` — spawn input is
  operator-controlled (`SystemRoot`); no injection (argv array), noted for
  completeness.

**L-3 · `pi-serena` `SERENA_PYTHON` env override**
- `pi-serena/extensions/worker.ts` — spawns whatever `SERENA_PYTHON` points at
  (argv array, no shell). Standard env-trust model; document in README rather
  than change.

### Clean vectors (explicitly audited, no finding)

- **Shell exec**: all spawns across pi-a2a, pi-sub, pi-subagent, pi-serena,
  pi-cron, pi-rtk, pi-commandcode, pi-router use argv arrays (no
  `shell:true`, no string concat into a shell). pi-windows-tools
  `buildShellArgs` intentionally passes the command to a shell — it IS the
  shell tool, gated upstream by pi permissions; WSL/`--` separation and
  `-EncodedCommand` handling are correct.
- **SSRF**: pi-a2a `client.ts` blocks private/link-local/CGNAT ranges
  (`isPrivateHost`, IPv4-mapped handling) and pins gateway RPC to the proxy
  origin; discovery URLs from the network never receive the shared token.
- **Commandcode/router tokens**: `Authorization: Bearer` from env/config only;
  non-secret settings files explicitly separate secret config
  (`pi-commandcode/extensions/lib/config.ts` header comment).
- **Archive extraction**: no tar/zip extraction code exists anywhere in the
  repo — vector not present.
- **eval/Function**: zero occurrences.
- **pi-notebooklm temp files**: `mkdtempSync(join(tmpdir(), "pi-notebooklm-"))`
  (fixed pattern from the earlier race fix holds).

## Two-tier doctrine — CRITICAL-PASS CANDIDATES (for a glm-5.3 non-flash review)

Items where a second, deeper pass has the highest expected value:

1. **`pi-a2a/extensions/lib/server.ts` dispatch pipeline** — inbound wrap →
   runner → redaction → artifact store. H-1 changed three of its outputs; a
   deeper pass should trace every remaining path where worker output reaches
   `store.update` / JSON-RPC responses (progress events, artifact deltas,
   push-notification payloads) for the same configured-token leak class.
2. **`pi-a2a gateway upstream channel`** — the reverse channel (firewalled
   peers) and `upstreamToken` minting: verify the minted token can never be
   confused for an operator token in `authenticate()`'s `extraTokens` path,
   including the panel-edit flows.
3. **`pi-web web_interact` dialog arming** — decide the product answer to M-1
   (allowlist vs confirm hook) with real injection-payload testing.
4. **`pi-commandcode` UA/Cloudflare path** — the curl-vs-python UA split
   (CF-1010) means error text from the provider can embed request internals;
   check nothing forwards provider error bodies into command lines.

## Verification on this branch

- `pi-a2a`: 395 passing / 3 pending / 0 failing (includes 5 new tests).
- Full per-package test sweep: see branch report / `.test-*.log` in the run
  workspace (results summarized in the delivery report).
- No secret material in the diff: all test token strings are synthetic
  (`alpha-bearer-token-9876`, `shared-token-aabbcc-1122334455`, …) — grep the
  diff for the real `.env` token values returned zero hits before push.
