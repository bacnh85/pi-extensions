#!/usr/bin/env node
// Backfill nested integrity hashes stripped by npm install re-idealization.
// Per docs/pi-version-bumps.md step 5. Run: node scripts/backfill-integrity.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";

const hashCache = new Map(); // "name@version" -> { integrity, tarball }
function view(name, version) {
  const k = `${name}@${version}`;
  if (!hashCache.has(k)) {
    const out = execSync(`npm view ${JSON.stringify(k)} dist.integrity dist.tarball --json`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const j = JSON.parse(out);
    hashCache.set(k, { integrity: j["dist.integrity"], tarball: j["dist.tarball"] });
  }
  return hashCache.get(k);
}

let totalFilled = 0, totalChecked = 0, failures = [];
for (const dir of readdirSync(".").filter((d) => d.startsWith("pi-"))) {
  const lockPath = `${dir}/package-lock.json`;
  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, "utf8")); } catch { continue; }
  let dirty = false;
  for (const [key, node] of Object.entries(lock.packages || {})) {
    if (!node.resolved || node.integrity || key.endsWith("node_modules/.package-lock.json")) continue;
    const name = key.replace(/^.*node_modules\//, "");
    totalChecked++;
    try {
      const d = view(name, node.version);
      const { integrity, tarball } = d;
      if (!integrity) { failures.push(`${dir}: no integrity for ${name}@${node.version}`); continue; }
      // Assert resolved URL matches the registry tarball (scheme-insensitive).
      const ru = node.resolved.replace(/^http:/, "https:");
      if (tarball && !ru.endsWith(new URL(tarball).pathname)) {
        failures.push(`${dir}: URL mismatch ${name}@${node.version}: ${node.resolved} vs ${tarball}`);
        continue;
      }
      node.integrity = integrity;
      totalFilled++; dirty = true;
    } catch (e) {
      failures.push(`${dir}: view failed ${name}@${node.version}: ${e.message.split("\n")[0]}`);
    }
  }
  if (dirty) writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}
console.log(`filled=${totalFilled} missingRemaining=${failures.length}`);
for (const f of failures.slice(0, 20)) console.log("  " + f);
// Remaining gaps (view failures, missing hashes, URL mismatches) must fail
// loudly — CI's lockfile-coverage guard depends on them never slipping by.
process.exitCode = failures.length ? 1 : 0;
