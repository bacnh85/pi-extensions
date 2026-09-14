// Version gate for pi-rtk's find-predicate blocklist.
//
// rtk 0.46 dispatches on find's grammar and passes unmodeled predicates through
// to real find (never-worse guard); older rtk needs the strict blocklist.
// ponytail: this export surface is FROZEN once shipped — pi's jiti loader
// pairs a reloaded index.ts with a stale cached copy of existing sibling
// modules, so a NEW export here crashes /reload in running sessions (bit us
// twice: "parseSemver is not a function", then "isAtLeastVersion is not a
// function" after 0.2.1 exported it). New helpers go in a brand-new file.
export const RTK_FIND_PASSTHROUGH_VERSION = [0, 46, 0];

// Minimal semver triple parse; returns null when unparseable (conservative).
export function parseSemver(raw) {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

function isAtLeastVersion(current, minimum) {
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
