---
name: ux-capture
description: >
  Capture playbook for the pi-ux render-and-inspect loop: screenshotting a UI
  you just built via local headless Chrome vs web_screenshot, daemon
  reachability (localhost vs LAN IP vs host.docker.internal), SSRF-protected
  daemons, and cloudflared tunnels. Load when setting up render inspection or
  when a UI screenshot capture fails.
---

# UX Capture Playbook

Judge captures at viewer resolution (1×–3×); never chase sub-visible precision.

## Default — local capture (offline, no daemon)

Headless Chrome writes the PNG; the `read` tool shows it inline (multimodal models see it).

- Linux: `google-chrome --headless --screenshot=/tmp/shot.png --window-size=1280,800 http://localhost:PORT` (or `chromium`)
- macOS: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=/tmp/shot.png --window-size=1280,800 http://localhost:PORT`

## Alternative — web_screenshot (daemon-rendered, pi-web 0.6.2+)

The screenshot URL is navigated by the DAEMON's browser, so addresses must resolve on the daemon host:

- Reachable: your machine's LAN IP, or `host.docker.internal` for a Dockerized daemon.
- Plain localhost/file:// only for a daemon you *know* runs natively on this machine — `web_status` can't tell you (a Dockerized daemon on a published port also shows 127.0.0.1 + healthy but cannot see your localhost).
- SSRF-protected daemons (common) block private/localhost URLs outright — failures say "URL blocked (SSRF protection)".
- Last resort: a temporary public tunnel (`cloudflared tunnel --url http://localhost:PORT`) when the remote daemon must render the page; quick tunnels are often flaky. If all capture paths fail, fall back to the deterministic `ux_audit` gates only.
