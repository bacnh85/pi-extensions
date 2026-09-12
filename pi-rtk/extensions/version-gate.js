// Version gate for pi-rtk's find-predicate blocklist.
//
// rtk 0.46 dispatches on find's grammar and passes unmodeled predicates through
// to real find (never-worse guard); older rtk needs the strict blocklist.
// Lives in its own file because pi's jiti loader can pair a reloaded index.ts
// with a stale cached copy of an EXISTING module — importing a new export from
// findFallback.js crashed at import time ("parseSemver is not a function"). A
// brand-new file has no stale copy, so the import is always safe.
export const RTK_FIND_PASSTHROUGH_VERSION = [0, 46, 0];

// Minimal semver triple parse; returns null when unparseable (conservative).
export function parseSemver(raw) {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

export function isAtLeastVersion(current, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (current[i] > minimum[i]) return true;
    if (current[i] < minimum[i]) return false;
  }
  return true;
}

export function supportsFindPassthrough(versionOutput) {
  const parsed = parseSemver(String(versionOutput ?? "").replace(/^rtk\s+/, ""));
  return !!parsed && isAtLeastVersion(parsed, RTK_FIND_PASSTHROUGH_VERSION);
}
