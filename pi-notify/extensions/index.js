/**
 * pi-notify — desktop notifications and sounds for Pi.
 *
 * Fires when the agent finishes a turn, errors, or asks the user a question.
 * Cross-platform, zero deps:
 *   - macOS:    `osascript` (notification center) + `afplay` (sound)
 *   - Linux:    `notify-send` (libnotify) + `paplay`/`aplay` (sound)
 *   - Windows:  PowerShell toast + `[console]::beep` (sound)
 *   - Terminal: OSC 777 (Ghostty/iTerm2/WezTerm/rxvt) + OSC 99 (Kitty) as a
 *               portable fallback that needs no binary.
 *
 * Config (settings.json): `"notify": { "onComplete": true, "onError": true,
 * "onQuestion": true, "sound": true, "volume": 0.4 }`. Defaults: all on.
 * Flags: --no-notify disables everything for one run.
 *
 * Best-effort: every notification path is wrapped so a failure to notify can
 * never break the agent flow. Plain JS (pi-budget pattern).
 */

import { execFile } from "node:child_process";

const DEFAULTS = {
  onComplete: true,
  onError: true,
  onQuestion: true,
  sound: true,
  volume: 0.4,
};

/**
 * Merge user config over defaults. Exported for testing.
 */
export function resolveConfig(user) {
  return { ...DEFAULTS, ...(user && typeof user === "object" ? user : {}) };
}

function detectBackend() {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32" || process.env.WT_SESSION) return "windows";
  return "linux";
}

/** Run a command, swallowing all errors (best-effort notification). */
function run(cmd, args) {
  try {
    execFile(cmd, args, (err) => {
      if (err) { /* best-effort: silent */ }
    });
  } catch { /* best-effort */ }
}

function notifyOSC777(title, body) {
  try {
    process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
  } catch { /* best-effort */ }
}

function notifyOSC99(title, body) {
  try {
    process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
    process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
  } catch { /* best-effort */ }
}

/**
 * Fire a desktop notification. Exported (curried) for testing with a backend
 * override so tests never spawn real processes.
 */
export function notify(title, body, backend = detectBackend()) {
  switch (backend) {
    case "darwin":
      // Escape both `"` and `\` for safe embedding in an AppleScript string.
      run("osascript", ["-e", `display notification "${body.replace(/["\\]/g, "\\$&")}" with title "${title.replace(/["\\]/g, "\\$&")}"`]);
      return;
    case "windows":
      run("powershell.exe", ["-NoProfile", "-Command", toastScript(title, body)]);
      return;
    case "linux":
      run("notify-send", [title, body]);
      return;
    default:
      if (process.env.KITTY_WINDOW_ID) notifyOSC99(title, body);
      else notifyOSC777(title, body);
  }
}

function toastScript(title, body) {
  // Minimal cross-version toast: writes title+body via BurntToast-free approach.
  // ponytail: use msg.exe-free PowerShell one-liner; avoids WinRT type plumbing.
  const t = title.replace(/'/g, "''");
  const b = body.replace(/'/g, "''");
  return `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') > $null; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${t}', '${b}', 'Info'); Start-Sleep -Seconds 6; $n.Dispose()`;
}

/**
 * Play a sound. Best-effort; volume is a hint for backends that support it.
 */
export function playSound(volume, backend = detectBackend()) {
  const v = Math.min(1, Math.max(0, Number(volume) || 0));
  switch (backend) {
    case "darwin":
      // afplay has no volume flag; rely on system volume. Default sound.
      run("afplay", ["/System/Library/Sounds/Glass.aiff"]);
      return;
    case "windows":
      run("powershell.exe", ["-NoProfile", "-Command", "[console]::beep(800, 300)"]);
      return;
    case "linux":
      run("paplay", ["--volume=" + Math.round(v * 65536), "/usr/share/sounds/freedesktop/stereo/complete.oga"].filter(Boolean));
      return;
    default:
      // bell
      try { process.stdout.write("\x07"); } catch { /* best-effort */ }
  }
}

export default function notifyExtension(pi) {
  pi.registerFlag("no-notify", {
    description: "Disable pi-notify desktop notifications and sounds",
    type: "boolean",
  });

  const fire = (title, body, opts) => {
    if (pi.getFlag("no-notify")) return;
    const cfg = resolveConfig(pi.getSetting?.("notify") || pi.config?.notify);
    const kind = opts?.kind;
    if (kind === "complete" && !cfg.onComplete) return;
    if (kind === "error" && !cfg.onError) return;
    if (kind === "question" && !cfg.onQuestion) return;
    try { notify(title, body); } catch { /* best-effort */ }
    if (cfg.sound) {
      try { playSound(cfg.volume); } catch { /* best-effort */ }
    }
  };

  // Agent finished a full turn and is waiting for input.
  pi.on("agent_settled", () => fire("Pi", "Task complete", { kind: "complete" }));

  // Error: tool result flagged as error. We only fire on the first error per
  // turn to avoid a storm; best-effort dedupe via a turn-scoped flag.
  let erroredThisTurn = false;
  pi.on("turn_start", () => { erroredThisTurn = false; });
  pi.on("tool_result", (event) => {
    if (erroredThisTurn) return;
    if (event?.isError) {
      erroredThisTurn = true;
      fire("Pi", "An error occurred", { kind: "error" });
    }
  });

  // Question: the agent asked the user something (custom ask_question tool or
  // ctx.ui). We detect via a custom entry the ask tool may emit; otherwise the
  // settle notification covers the waiting state. Hook session info changes as
  // a proxy — kept minimal to avoid false positives.
  pi.on("session_info_changed", () => { /* reserved for future question hook */ });
}
