# Release process

1. Update `version` in the package's `package.json` (+ CHANGELOG entry).
2. Merge to main → publish workflow auto-publishes to npm if the version differs from the registry.
3. `@bacnh85/` scoped packages, public access (`publishConfig.access: "public"`).
