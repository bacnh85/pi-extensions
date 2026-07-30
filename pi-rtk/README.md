# @bacnh85/pi-rtk

Pi extension that rewrites bash tool calls through RTK for token savings.

## Behavior

- Listens for Pi `tool_call` events for the built-in `bash` tool.
- Listens for context-visible user shell commands entered as `!cmd`.
- Skips `!!cmd` user shell commands because their output is excluded from model context.
- Delegates command matching to `rtk rewrite`.
- Mutates agent bash commands in place or wraps user shell execution when RTK returns a rewrite.
- Falls back to native `find` when RTK would rewrite to unsupported compound/action `rtk find` predicates.
- Fails open on errors: commands pass through unchanged.
- Caches RTK-unavailable state briefly to avoid repeatedly probing a missing binary.
- Does not block, confirm, audit, or permission-gate commands.

## Commands

- `/rtk enable` enables rewrites for the current Pi session.
- `/rtk disable` disables rewrites for the current Pi session.
- `/rtk status` shows session state, cache state, and detected RTK details.
- `/rtk` shows status.

## Requirements

- `rtk >= 0.23.0` available in `PATH`.
- Set `RTK_DISABLED=1` to bypass rewrites. The extension reads this from the process environment, current working directory `.env.local`/`.env`, or Pi global config `.env.local`/`.env` under `$PI_CODING_AGENT_DIR` or `~/.pi/agent`.

## Install

```bash
pi install npm:@bacnh85/pi-rtk
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Test

```bash
RTK_DISABLED=1 pi -e ./pi-rtk
```
