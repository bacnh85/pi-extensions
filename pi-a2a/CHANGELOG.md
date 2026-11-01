# Changelog

## [0.9.0] - 2026-10-19

Validated against the A2A Integration Test Kit ([a2a-itk](https://github.com/a2aproject/a2a-itk)):
traversal `pi-a2a ⇄ a2a-python v1.0` passes (JSON-RPC, streaming and
non-streaming); ACTS JSON-RPC conformance goes from 12/59 MUST passing to
45/53 MUST, with every remaining failure an unimplemented optional behaviour
or the client-parse probe (see README → Protocol compliance).

### Added

- **`itk/` ITK agent** (`npm run itk-agent`): the real `A2AServer` with a
  deterministic runner in place of a model session, executing a2a-itk's
  protobuf `Instruction` with pi-a2a's own outbound client. `acts/sut-behaviors.yaml`
  declares the ACTS behaviours it implements.
- `SessionRunner` receives the inbound message's original `parts`.
- `sendTask` accepts explicit `parts` (programmatic callers forwarding
  structured or binary payloads).

### Fixed

The pre-1.0 aliases keep their legacy wire shapes (bare `Task` results,
`{id, state}` list stubs, whole-Task stream frames); fixes that change a shape
apply to the v1.0 methods only.

- **An unrecognised bearer token was rejected by a token-less server** (401),
  although the same request with no token is admitted. Clients that always send
  a credential — including a2a-itk's — could not call a default pi-a2a server.
  The token is now ignored when no tokens are configured (minted gateway tokens
  still resolve to their identity). A token-less server binds loopback only
  (`resolveBindHost`), so this admits nothing new from off-host.
- **A follow-up message with `taskId` started a new task** instead of continuing
  the `INPUT_REQUIRED` one (§3.4.3). It now resumes the same task and context,
  hands the runner the earlier turns, and rejects a terminal task
  (`UnsupportedOperationError`), a foreign/unknown task (`TaskNotFoundError`)
  or a contradicting `contextId` (`-32602`).
- **Tasks carried no `history`**; user and agent messages are now recorded and
  `historyLength` is honoured on `GetTask`, `ListTasks` and `SendMessage`.
- **The reply was only in `artifacts`**; the final status now carries it as
  `status.message` too, which is where most SDK clients (a2a-python, a2a-js)
  read it.
- **Streamed `TaskStatusUpdateEvent`s carried `final`**, a field v1.0 removed;
  strict ProtoJSON clients (a2a-python) rejected every pi-a2a stream.
- **A2A errors had no `google.rpc.ErrorInfo` detail** (§11.6), so clients could
  not map them; `TaskNotFound`, `TaskNotCancelable`, `UnsupportedOperation`,
  `VersionNotSupported`, `ContentTypeNotSupported` and
  `PushNotificationNotSupported` now carry it.
- **Unsupported `A2A-Version` majors were served as 1.0**; they now get
  `VersionNotSupportedError` (`-32009`). `0.x` and `1.x` are still served.
- **Optional operations pi-a2a does not offer answered "method not found"**:
  push-config methods now return `PushNotificationNotSupportedError` and
  `GetExtendedAgentCard` returns `UnsupportedOperationError`, as the card
  advertises.
- `SubscribeToTask` on a terminal task returns `UnsupportedOperationError`
  instead of a one-frame stream; `ListTasks` filters by `contextId`/`status`,
  honours `includeArtifacts=false` and returns `nextPageToken`; a request with
  no `method` is `InvalidRequest` (`-32600`); data parts with a non-JSON media
  type get `ContentTypeNotSupportedError`; the agent card is served with
  `Cache-Control` and `ETag`.

## 0.8.0 (2026-10-10)

- **Deferred tool tier** (ceulen pattern): all 7 `a2a_*` tools now register `exposure: "deferred"` — not declared to the model until `tool_search` loads them (they stay callable via `ctx.executeTool`/codemode). The package now force-activates `tool_search` in `session_start` when it defers tools (pi only auto-activates discovery for MCP servers). Unit tests pin the exposure flags and the activation branches.

## [0.7.13] - 2026-09-25

### Fixed

- **Gateway registration no longer blocks session start.** `A2AServer.start()`
  awaited `GatewayUpstream.start()`, which opens the channel + registers with a
  10s network timeout (and reconnects in a loop) — an unreachable switchboard
  stalled `session_start` for that entire window before the first prompt could
  be processed. The upstream now starts fire-and-forget; the 60s heartbeat
  self-heals registration and the existing status callback still announces the
  registered name. Verified: with the gateway unreachable (EHOSTUNREACH), the
  session starts instantly and logs `backing off 54s` (2026-09-24 latency
  report, benchmark 2026-09-25).

## [0.7.12] - 2026-09-23

### Fixed

- **Bounded retry for transient model-channel 503s (#470).** The child runner's
  retry budget is raised from `maxRetries: 1` to `{ maxRetries: 3,
  baseDelayMs: 1000 }` (about 7 seconds), so a distributor `No available
  channel` 503 on the final turn no longer kills the run. If the budget is
  exhausted, `isTransientChannelError()` labels the terminal error explicitly.
- **A provider-failed final turn maps to FAILED, not COMPLETED "(no reply)".**
  A dispatched child's run "finishes" whenever the agent loop ends, but that
  includes endings with no usable answer. The runner previously guarded only a
  length stop with no text (0.7.9 / #314); a final turn with `stopReason
  "error"` (e.g. HTTP 503 "no available channel") or a run with no assistant
  output at all returned normally, so the dispatcher got `TASK_STATE_COMPLETED`
  with `(no reply)` or a stale earlier turn's reply — a dead worker was
  indistinguishable from a finished one. The end-of-run decision moves into
  `lib/outcome.ts` (`terminalOutcomeError`) and now throws for all three cases,
  so `messageSend` maps the task to FAILED with the provider's error. Verified
  live against a 503ing provider (fleet #238/#322, task #425).
- **Agent card declares security in the A2A v1.0 shape.** `buildAgentCard`
  emitted the v0.3/OpenAPI `securitySchemes` shape
  (`{type:"http",scheme:"bearer"}`) and a v0.3 `security` list, which the
  spec-oracle conformance suite flags — a strict v1.0 client cannot read it.
  The card now emits the v1.0 `SecurityScheme` oneof
  (`{httpAuthSecurityScheme:{scheme:"bearer"}}`) plus `securityRequirements`
  with `StringList` scopes (`{list:[]}`), per `a2a.proto` and the spec's example
  card. The v0.3 `security` list is kept as a documented legacy alias so
  hermes's `a2a_discover` still shows "Auth required"; v1.0 parsers ignore it
  (task #427).

### Added

- **Inbound asserted identity (`X-A2A-Identity`).** A receiving server now
  honors the `X-A2A-Identity` header 0.7.11 already sends outbound, but only as
  attribution and only for a **loopback client of a loopback-bound server**: the
  asserted name refines the display name on the two identity-less admissions
  (anonymous loopback, shared bearer) and never borrows a token-backed
  identity, never flips a reject into an admit, and is ignored entirely for
  off-loopback callers. Names are sanitized (1–64 chars of `[A-Za-z0-9._-]`,
  alphanumeric first char) before they reach audit logs, task-ownership keys,
  and rate-limiter buckets. The inbound wrapper's framing now states how the
  peer connected (loopback / tailnet / remote) and how its identity was
  derived (token-verified / asserted / address-only). Without this, every local
  caller behind a loopback proxy showed as `ip:127.0.0.1` (task #423, fleet
  #322).
- **Session identity on outbound messages and in discovery.** Outbound messages
  stamp `pi/session` (the sender's pi session id) and `pi/self` (configured
  `selfIdentity`) as A2A v1.0 message metadata; the local registry and agent
  card advertise the host `sessionId`; an in-memory child (transcripts off)
  inherits the host session id instead of an ephemeral one nobody can map back.
  Receiving peers can join a dispatch to their own ledger rows and records on
  one key. All advisory display/join data — never authenticated (task #423,
  fleet #238).

## [0.7.11] - 2026-09-21

