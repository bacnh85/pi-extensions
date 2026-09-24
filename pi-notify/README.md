# pi-notify

Desktop notifications and sounds for [Pi](https://pi.dev).

Fires when the agent finishes a turn, errors, or asks the user a question. Cross-platform, zero dependencies. Inspired by OpenCode's `attention` feature.

## Install

```bash
pi install npm:@bacnh85/pi-notify
```

## Backends

| Platform | Notification | Sound |
|----------|-------------|-------|
| macOS | `osascript` (Notification Center) | `afplay` (Glass.aiff) |
| Linux | `notify-send` (libnotify) | `paplay` (freedesktop complete.oga) |
| Windows | PowerShell toast (NotifyIcon) | `[console]::beep` |
| Terminal | OSC 777 (Ghostty/iTerm2/WezTerm/rxvt) + OSC 99 (Kitty) | bell |

Falls back to terminal OSC protocols when no desktop binary is available.

## Configuration

Add a `notify` object to `.pi/settings.json` (project), `~/.pi/agent/settings.json` (global; `PI_CODING_AGENT_DIR` overrides), or `~/.pi/agents/settings.json` — the first settings.json containing a `notify` object wins (files without one are skipped):

```json
{
  "notify": {
    "onComplete": true,
    "onError": true,
    "onQuestion": true,
    "sound": true,
    "volume": 0.4
  }
}
```

All keys default to `true` (sound defaults on, volume `0.4`). Omit the object entirely to get all notifications.

`volume` only applies on Linux (`paplay --volume`, range 0–1). macOS (`afplay`)
has no volume flag and ignores it — adjust the system volume; Windows uses a
fixed `beep`.

## Flag

| Flag | Description |
|------|-------------|
| `--no-notify` | Disable all notifications and sounds for this run |

## Events

| Event | When |
|-------|------|
| `onComplete` | Agent finishes a full turn (`agent_settled`) |
| `onError` | A tool result is flagged as an error (deduped per turn) |
| `onQuestion` | Pi blocks on a user-facing prompt (`ui_prompt_start`) — e.g. `ask_user_question` |

## Why

Long-running agent tasks finish silently. A desktop notification when the work is done — or when something breaks — lets you context-switch away without polling.

## License

MIT
