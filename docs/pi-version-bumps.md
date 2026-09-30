# Pi version bumps (full procedure)

After each Pi minor release, verify extensions against the new SDK:

1. Check the Pi CHANGELOG for "Breaking Changes" that affect extension APIs (TypeBox imports, ExtensionAPI exports, etc.).
2. Widen peer caps `<0.x.0` → `<0.(x+1).0` in every package with a bounded peer — keep the existing floor, change only the cap. Find them with: `grep -l 'pi-coding-agent": "[^"]*<' pi-*/package.json` (re-run the grep rather than trusting any cached list).
3. Bump their devDeps from `^0.x.0` to `^0.(x+1).0`.
4. Patch-version-bump + CHANGELOG every package the grep lists (peer ranges ship in the published artifact, so a cap change is a version change).
5. Refresh lockfiles in all packages so `npm ci` installs the new SDK — then
   backfill nested integrity hashes. npm quirk: `npm install` re-idealization
   strips `integrity` from nested
   `node_modules/@earendil-works/pi-coding-agent/node_modules/*` entries, which
   fails CI's "Verify lockfile integrity coverage" guard (bit us on 0.85.0 and
   0.85.1). For every entry with `resolved` but no `integrity`, inject the
   authoritative hash and assert the resolved URL matches the registry tarball:

   ```bash
   npm view @earendil-works/<pkg>@<version> dist.integrity
   ```

   `npm ci` accepts and preserves hand-added hashes; `npm install` strips them
   again — re-run the backfill after any install in this repo.
   Convenience script: `node scripts/backfill-integrity.mjs` does the scan +
   inject + URL assertion across all packages; it exits non-zero if any entry
   remains unfilled (offline, unpublished, or URL mismatch).
6. Run tests and typecheck; verify the installed SDK version per package.
