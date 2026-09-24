/**
 * Hermetic scratch directories for tests.
 *
 * Every scratch dir used to be created directly under `os.tmpdir()`, which
 * makes ordinary test execution depend on the ambient system temp directory
 * being usable: read-only `/tmp` mounts, hardened CI images, and sandboxed
 * agents all break `fs.mkdtempSync` with EPERM/EROFS — an environmental
 * failure that says nothing about the behavior under test.
 *
 * `makeTempDir()` keeps preferring the ambient temp dir (identical behavior
 * wherever it works) and falls back to a scratch root inside the test tree,
 * which is writable wherever the suite can run at all. No platform detection:
 * the choice is a writability probe. Created dirs are swept at process exit
 * so the in-tree fallback never litters the checkout.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Scratch root inside the test tree, used only when ambient temp is not
 * usable. Gitignored (see test/.gitignore). */
export const TREE_SCRATCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".scratch");

/** `base` if a scratch dir can be created under it, else null. */
function usableBase(base: string): string | null {
  try {
    const probe = mkdtempSync(join(base, "pi-a2a-probe-"));
    rmSync(probe, { recursive: true, force: true });
    return base;
  } catch {
    return null;
  }
}

/** Base directory for test scratch dirs: the ambient temp dir when usable,
 * else the in-tree scratch root. Probed on every call (a probe is one
 * mkdtemp+rm), so environment changes mid-process are picked up. */
export function resolveTempBase(): string {
  return usableBase(tmpdir()) ?? TREE_SCRATCH_ROOT;
}

const created = new Set<string>();
let sweepHooked = false;

/** A unique scratch directory (mkdtemp) under a writable base. */
export function makeTempDir(prefix = "pi-a2a-"): string {
  const base = resolveTempBase();
  if (base === TREE_SCRATCH_ROOT) mkdirSync(TREE_SCRATCH_ROOT, { recursive: true });
  if (!sweepHooked) {
    sweepHooked = true;
    process.on("exit", () => {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
    });
  }
  const dir = mkdtempSync(join(base, prefix));
  created.add(dir);
  return dir;
}
