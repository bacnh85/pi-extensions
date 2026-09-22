# pi-extensions hardening round 6 — burn-pi-hard6-0923 (2026-09-23)

Scope: **CI gate integrity** — first round on the workflow surface. Rounds 3–5
covered pi-a2a lib (server.ts / client.ts / gateway.ts); secvuln 1–2 the
security redaction chain. This round is CI-only, zero package source changes.

## Frontier

- Base: **origin/main @ 44f739e** (fresh clone, == booking-time main).
- NOT stacked on the unmerged pi-a2a chain (secvuln2-0920 → hard4-0920 →
  hard5-0921): touches only `.github/workflows/ci.yml` + this doc, so it can
  merge independently of that stack.

## Findings / fixes

**F-1 · Typecheck gate drift (4 packages)**

- pi-fff, pi-notebooklm, pi-obsidian, pi-rtk each define
  `npm run typecheck` (`tsc --noEmit`) in package.json — and their CI matrix
  command never ran it. Local devs pass a gate CI does not enforce; a type
  break could ship to npm.
- All 4 verified GREEN on a fresh `npm ci` (exit 0 ×4) **before** wiring them
  in, so the new gate starts green. Matrix cmds updated accordingly.
- pi-rtk additionally gained `npm ci` (it was the only lockfile-carrying
  package whose CI cmd lacked it; tsc needs devDeps). Its
  `npm test && npm pack --dry-run` tail is preserved.

**F-2 · Matrix / paths-filter parity guard (regression test for c13fa72's bug class)**

- c13fa72 proved the class: pi-windows-tools silently drifted out of BOTH the
  paths-filter and the matrix → its security fixes (0.5.5, 0.5.6) were never
  tested nor published. Nothing prevented a repeat.
- New `changes`-job step (`Verify matrix/paths-filter parity with package
  dirs`): fails CI when any `pi-*` directory is missing from the filter map or
  the matrix, or a matrix entry has no directory. 3-way parity verified
  34/34/34 on this repo.

## Tests / verification

- Guard RED/GREEN: extracted the embedded heredoc from the YAML **after block
  scalar dedent** (exactly what CI executes) — clean repo → exit 0
  ("Matrix parity OK: 34 packages"); simulated drift (matrix-only
  `pi-zzz-fake` entry) → exit 1 naming the entry.
- Full new-gate run per touched package, all exit 0:
  pi-fff 28 passing · pi-notebooklm 188 passing · pi-obsidian 143 passing ·
  pi-rtk node --test green + `npm pack --dry-run` ok (0.2.4, 8 files) ·
  `tsc --noEmit` ×4 clean.
- No package source changes → no version bumps, no CHANGELOG entries
  (same policy as c13fa72).

## Still open / next recommended increments

1. **Typecheck gates for TS packages lacking the script**: pi-evolve (9 TS
   files), pi-munin (7), pi-serena (11), pi-sub (5), pi-web (40),
   pi-selfskills (10) — add `typecheck: tsc --noEmit` + CI cmd, same recipe.
2. pi-router test script pins one file (`extensions/test/unit.test.ts`)
   instead of a glob — latent skip risk if a second test file lands.
3. Unmerged pi-a2a hardening stack (hard4 3e29e8f → hard5 9d6ef86) still
   awaits user review/merge.
