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

**Disable entrance animations when capturing**: pass `reduced_motion=true` to
`web_screenshot` / `web_interact` (pi-web ≥0.16.0), or add
`--force-prefers-reduced-motion` to manual headless Chrome (or emulate the media
query). Pages rightly use staggered page-load reveals with `opacity:0`
backwards-fill — captured mid-animation they screenshot as blank sections,
and you will "fix" content that isn't broken. The same forced query doubles
as a reduced-motion audit: with animations off, every section must still be
fully visible and readable.

**Capture at the brief's target viewport.** Web pages: 1280–1440 wide. App
screens and mobile-first briefs: the width the brief names (usually 390) at
its target height (~844). pi-web handles this honestly now: `web_screenshot`
and `web_interact` with `width`/`viewport` below 500px automatically use CDP
device-metrics emulation (true 390px CSS viewport) and return a
`scrollWidth`/`innerWidth` probe — `scrollWidth > width` means overflowing CSS.
If you fall back to manual headless Chrome, know its trap: many builds
**clamp window width to 500px**, so a "390 capture" secretly renders at 500
and crops (see the layout probe below for the wrapper that does it honestly).
If content overflows or dead-ends at the target size, the page is broken —
**fix the page. Never widen the viewport to make a problem invisible.**

## Interaction — web_interact (pi-web ≥0.16.0)

A screenshot proves the page LOOKS right; only interaction proves it WORKS.
After visual inspection, verify behavior with `web_interact` — one call = one
browser lifecycle: open `url`, run `steps` in order, get per-step results, a
final inline PNG, and a scrollWidth probe.

```text
web_interact url="http://localhost:5173" viewport={width:390,height:844} \
  reduced_motion=true grant=["clipboard-read","clipboard-write"] steps=[
  {click: "#copy-btn"},
  {evaluate: "document.getElementById('status').textContent", label: "status"},
  {type: {selector: "#email", text: "a@b.co"}},
  {press: "Enter"},
  {wait_for: "[data-success]"}
```

- **Trusted clicks**: steps click via CDP `Input.dispatchMouseEvent` at the
  element's center — synthetic `el.click()` grants no user activation, so
  `document.execCommand('copy')` and login/clipboard flows would silently fail
  under it. Under a trusted click, copy returns true.
- **evaluate is double-unwrapped**: `Runtime.evaluate` nests the value at
  `{result:{result:{value}}}` — the tool returns the real value; if you ever
  hand-roll CDP, single-unwrapping yields `undefined` and makes the app LOOK
  broken when it isn't.
- Steps stop at the first failure with the reason — a broken selector surfaces
  loudly instead of no-op'ing later steps.
- Clipboard readback on insecure origins: there is no clipboard API to read
  back with; `execCommand` returning true under a trusted click is the
  strongest available signal (grant permissions for secure origins).

Manual CDP (fallback only, when web_interact is unavailable): launch Chrome
with `--remote-debugging-port=0`, read `<profile>/DevToolsActivePort` for the
ws URL, create targets over the websocket (`Target.createTarget` — not the
`/json/new` HTTP endpoint, whose method flipped to PUT), attach with
`flatten: true`.

## Layout probe (fallback for manual captures)

Needed only when CDP tooling above is unavailable. Two Chrome facts make naive mobile checks lie:

1. **Headless Chrome clamps window width to 500px.** A `--window-size=390`
   capture renders the page at 500px and crops the PNG to 390 — cuts at the
   right edge are the CROP, not your CSS. Detect it:
   `--dump-dom` a page containing `window.innerWidth` — 500 at a 390 request
   means clamped.
2. `window.innerWidth` therefore never reports the true mobile viewport.

The honest way to see and measure a 390px screen: a **wrapper page with a
390×844 iframe** (an iframe IS a true 390px CSS viewport, immune to the
clamp), rendered at a 500px window with `--allow-file-access-from-files`:

```bash
cp index.html /tmp/page.html
cat > /tmp/wrapper.html <<'EOF'
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#888}#frame{width:390px;height:844px;border:0;outline:2px solid #000}
</style></head><body>
<iframe id="frame" src="./page.html"></iframe>
<pre id="out">measuring…</pre>
<script>
const f=document.getElementById('frame');
f.addEventListener('load',()=>{
  const d=f.contentDocument;
  document.getElementById('out').textContent=
    'page scrollWidth:'+d.documentElement.scrollWidth+' / viewport:390';
});
</script>
</body></html>
EOF
"$CHROME" --headless --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=6000 --window-size=500,900 \
  --screenshot=/tmp/mobile-390.png "file:///tmp/wrapper.html"
"$CHROME" --headless --disable-gpu --allow-file-access-from-files \
  --virtual-time-budget=6000 --window-size=500,900 \
  --dump-dom "file:///tmp/wrapper.html" | grep -o 'page scrollWidth:[^<]*'
```

**Pass = scrollWidth 390 / viewport:390**, and the screenshot shows the true
mobile render (grey letterbox on the right is the wrapper, not your page).
If scrollWidth exceeds 390, fix the CSS (min-width on rows/grid, an
unbreakable string, a fixed-width column) and probe again — on the delivered
file, after the last edit.

**Alternative: puppeteer-core device emulation** (when node ≥18 and npm are
available — no wrapper file, and it gives true `fullPage` + a JS overflow
probe): `npm i puppeteer-core` once, then launch with
`executablePath` pointing at installed Chrome and
`page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })`.
`setViewport` is real device-metrics emulation — immune to the window clamp.
Probe with `document.documentElement.scrollWidth` via `page.evaluate` before
screenshotting; `page.screenshot({ fullPage: true })` for the tall capture.

## Default — web_screenshot (pi-web ≥0.16.0, auto local detection)

`web_screenshot` auto-routes localhost/LAN/file URLs to the locally installed
headless Chrome and returns the PNG inline — no daemon, no manual commands:

- `web_screenshot url="http://localhost:PORT" width=390 height=844` — the
  model sees the render; below 500px the capture is CDP device-emulated
  (honest viewport, no clamp) and includes the scrollWidth probe.
- `reduced_motion=true` disables entrance animations for the shot.
- `full_page=true` captures a tall 8000px window; `wait_for` settles JS via
  `--virtual-time-budget`; `engine="local"` forces local on a public URL.
- `web_pdf` works the same way (`--print-to-pdf`) for full-content archival.
- If Chrome is missing: `web_status` shows `localChrome.path`; set `CHROME_PATH`.
- Empty replies / connection resets from a dev-server URL usually mean a
  STALE HUNG server on the port (accepts TCP, returns nothing) — `lsof -ti
  :PORT` and kill it before diagnosing the tools.

## Fallback — manual headless Chrome (pi-web <0.7.0 or if the tool errors)

Headless Chrome writes the PNG; the `read` tool shows it inline (multimodal models see it). Keep `--window-size` at the target viewport (e.g. `390,844` for a phone screen) — never widen it to hide overflow.

- Linux: `google-chrome --headless --screenshot=/tmp/shot.png --window-size=1280,800 http://localhost:PORT` (or `chromium`)
- macOS: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --screenshot=/tmp/shot.png --window-size=1280,800 http://localhost:PORT`

## Alternative — web_screenshot (daemon-rendered, pi-web 0.6.2+)

The screenshot URL is navigated by the DAEMON's browser, so addresses must resolve on the daemon host:

- Reachable: your machine's LAN IP, or `host.docker.internal` for a Dockerized daemon.
- Plain localhost/file:// only for a daemon you *know* runs natively on this machine — `web_status` can't tell you (a Dockerized daemon on a published port also shows 127.0.0.1 + healthy but cannot see your localhost).
- SSRF-protected daemons (common) block private/localhost URLs outright — failures say "URL blocked (SSRF protection)".
- Last resort: a temporary public tunnel (`cloudflared tunnel --url http://localhost:PORT`) when the remote daemon must render the page; quick tunnels are often flaky. If all capture paths fail, fall back to the deterministic `ux_audit` gates only.
