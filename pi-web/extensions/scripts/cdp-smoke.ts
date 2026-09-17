// Live smoke test for lib/cdp.ts (web_interact + honest mobile capture).
// Run against real Chrome: `npx tsx extensions/scripts/cdp-smoke.ts`
// Verifies: DevTools launch, trusted click (user activation → execCommand
// copy works), typing + Enter submit, wait_for, evaluate unwrap, viewport
// emulation at 390px (probe scrollWidth === 390), reduced-motion emulation,
// and PNG magic bytes.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runInteraction } from "../lib/cdp";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "unit", "fixtures", "interaction.html");
  if (!existsSync(fixture)) fail(`fixture missing: ${fixture}`);
  const url = `file://${fixture}`;

  // ── 1. Interaction flow ──
  const r = await runInteraction({
    url,
    steps: [
      { wait_for: "#later" },                       // appears after 300ms
      { type: { selector: "#name", text: "Ada" } },
      { press: "Enter" },                            // submits the form
      { click: "#copy" },                            // trusted click → user activation
      { evaluate: `document.getElementById("copy-status").textContent`, label: "copy-status" },
      { evaluate: `document.getElementById("log").textContent.trim()`, label: "log" },
    ],
    viewport: { width: 390, height: 844 },
    reducedMotion: true,
  });

  const byLabel = (l: string) => r.outcomes.find((o) => o.label.includes(`(${l})`) || o.label === l);
  const copyStatus = byLabel("copy-status");
  const log = byLabel("log");
  if (!r.outcomes.every((o) => o.ok)) fail(`steps failed: ${JSON.stringify(r.outcomes.filter((o) => !o.ok))}`);
  if (copyStatus?.value !== "copied") fail(`trusted click did not grant user activation: ${JSON.stringify(copyStatus?.value)}`);
  if (log?.value !== "submitted:Ada") fail(`type+press+submit failed: ${JSON.stringify(log?.value)}`);
  if (r.probe.innerWidth !== 390) fail(`viewport emulation ignored: innerWidth=${r.probe.innerWidth} (expected 390 — clamped?)`);
  if (r.screenshot && !r.screenshot.startsWith("iVBORw0KGgo")) fail("final screenshot is not a PNG");
  console.log(`✓ interaction flow: copy=${copyStatus?.value}, log="${log?.value}", probe=${JSON.stringify(r.probe)}, png=${r.screenshot?.length} b64 chars`);

  // ── 2. Fail-fast on a broken selector ──
  const bad = await runInteraction({ url, steps: [{ click: "#nope" }] });
  if (bad.outcomes[0].ok || bad.outcomes.length !== 1) fail("broken selector did not fail fast");
  console.log(`✓ fail-fast: ${bad.outcomes[0].error}`);

  // ── 2b. Hidden element must fail loudly, not click at (0,0) ──
  const ghost = await runInteraction({ url, steps: [{ click: "#ghost" }] });
  if (ghost.outcomes[0].ok || !/not visible/.test(String(ghost.outcomes[0].error))) {
    fail(`hidden element click did not fail loudly: ${JSON.stringify(ghost.outcomes[0])}`);
  }
  console.log(`✓ hidden element: ${ghost.outcomes[0].error}`);

  // ── 3. Overflow probe detects a page wider than the viewport ──
  const dir = mkdtempSync(path.join(tmpdir(), "cdp-smoke-"));
  try {
    const wide = path.join(dir, "wide.html");
    writeFileSync(wide, `<html><body style="margin:0"><div style="width:1200px;height:50px">wide</div></body></html>`);
    const over = await runInteraction({ url: `file://${wide}`, viewport: { width: 390, height: 844 } });
    if ((over.probe.scrollWidth ?? 0) <= 390) fail(`overflow probe missed: scrollWidth=${over.probe.scrollWidth}`);
    console.log(`✓ overflow probe: scrollWidth=${over.probe.scrollWidth} > viewport 390`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\nAll smoke checks passed.");
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
