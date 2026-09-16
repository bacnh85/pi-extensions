#!/usr/bin/env bash
# pi-ux design benchmark — run one brief headless with pi + pi-ux, then capture
# rendered evidence for rubric scoring. Results are gitignored.
#
# usage: bench/run.sh <landing|dashboard|mobile> [run-label]
#
# Environment: pi on PATH; zai-anthropic auth in ~/.pi/agent/auth.json;
# Chrome installed (or CHROME_PATH set). Same model flags every run so runs
# are comparable.
set -euo pipefail

BRIEF_NAME="${1:?usage: run.sh <landing|dashboard|mobile> [run-label]}"
LABEL="${2:-$(date +%Y-%m-%dT%H%M%S)}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$DIR/.." && pwd)"
ROOT="$(dirname "$PKG")"
BRIEF="$DIR/briefs/$BRIEF_NAME.md"
[ -f "$BRIEF" ] || { echo "no such brief: $BRIEF_NAME (landing|dashboard|mobile)"; exit 1; }
command -v pi >/dev/null || { echo "pi not on PATH"; exit 1; }

OUT="$DIR/results/$LABEL/$BRIEF_NAME"
mkdir -p "$OUT"
WORK="$(mktemp -d /tmp/pi-ux-bench.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# The output-file instruction is part of the harness, not the brief, so briefs
# stay natural. Google Fonts links allowed; no other external assets.
PROMPT="$(cat "$BRIEF")

Write the result as a single self-contained HTML file at ./index.html in the current directory (inline <style>; Google Fonts via <link> allowed; no other external assets)."

cd "$WORK"
echo "running pi ($BRIEF_NAME, label $LABEL)…"
pi -p --no-session --mode json \
  -ne \
  -e "$PKG" \
  -e "$ROOT/pi-web" \
  -e "$ROOT/pi-model-tools" \
  --provider zai-anthropic --model glm-5.3-flash \
  "$PROMPT" > "$OUT/session.jsonl"

[ -f index.html ] || { echo "PI PRODUCED NO index.html" | tee "$OUT/ERROR"; exit 1; }
cp index.html "$OUT/page.html"

CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || CHROME="$(command -v google-chrome || command -v chromium || true)"
[ -n "$CHROME" ] && [ -x "$CHROME" ] || { echo "no Chrome found; page.html saved only" | tee "$OUT/ERROR"; exit 0; }

shot() { "$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-prefers-reduced-motion \
  --virtual-time-budget=12000 --window-size="$1" \
  --screenshot="$2" "file://$WORK/index.html" >/dev/null 2>&1 || true; }

# Full-page capture at the page's REAL height: a fixed tall window stretches
# 100vh sections into blank voids. Probe scrollHeight at a 900px viewport first.
page_height() {
  local f="$1"
  python3 - "$f" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
probe = src.replace('</body>', '<script>document.write("<pre id=hh>"+document.documentElement.scrollHeight+"</pre>")</script></body>')
open('/tmp/_hprobe.html', 'w').write(probe)
PYEOF
  "$CHROME" --headless --disable-gpu --force-prefers-reduced-motion \
    --virtual-time-budget=8000 --window-size=1440,900 --dump-dom "file:///tmp/_hprobe.html" 2>/dev/null \
    | grep -o '<pre id="hh">[0-9]*' | tail -1 | grep -o '[0-9]*' || echo 4000
}

shot "1440,900"  "$OUT/desktop-viewport.png"
FULL_H=$(page_height "$WORK/index.html")
[ "$FULL_H" -lt 900 ] 2>/dev/null && FULL_H=900
[ "$FULL_H" -gt 8000 ] 2>/dev/null && FULL_H=8000
shot "1440,$FULL_H" "$OUT/desktop-full.png"
if [ "$BRIEF_NAME" = mobile ]; then
  # Headless Chrome clamps windows to 500px wide, so a direct 390px capture
  # crops a 500px render. Shoot a 390x844 iframe wrapper instead — the iframe
  # is a true 390px viewport. The tall pass reuses the same wrapper logic.
  mshot() {
    local h="$1" out="$2"
    cat > "$WORK/wrapper.html" <<EOF
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#888}#frame{width:390px;height:${h}px;border:0;outline:2px solid #000;background:#fff}
</style></head><body><iframe id="frame" src="./index.html"></iframe></body></html>
EOF
    "$CHROME" --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files \
      --virtual-time-budget=12000 --window-size="500,$((h + 40))" \
      --screenshot="$out" "file://$WORK/wrapper.html" >/dev/null 2>&1 || true
  }
  mshot 844  "$OUT/mobile-viewport-390.png"
  mshot 3000 "$OUT/mobile-full.png"
else
  shot "390,3000"  "$OUT/mobile-full.png"
fi
echo "done → $OUT"
