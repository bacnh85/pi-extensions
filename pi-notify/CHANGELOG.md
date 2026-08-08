# Changelog

## 0.1.0

- Initial release.
- Desktop notifications on task completion (`agent_settled`) and errors (`tool_result` with `isError`).
- Cross-platform: macOS (`osascript`), Linux (`notify-send`), Windows (PowerShell toast), terminal OSC 777/99 fallback.
- Optional sounds per platform (`afplay`/`paplay`/`beep`/bell).
- `notify` settings object (`onComplete`, `onError`, `onQuestion`, `sound`, `volume`).
- `--no-notify` flag to disable for one run.
- Per-turn error dedupe.
- Zero dependencies, plain JS.
