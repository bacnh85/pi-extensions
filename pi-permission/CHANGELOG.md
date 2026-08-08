# Changelog

## 0.1.0

- Initial release.
- Config-driven `allow`/`ask`/`deny` permission rules per tool, with wildcard pattern matching.
- `external_directory` deny-gate for paths outside the project working directory.
- Doom-loop guard (blocks 3rd identical tool call).
- `--yolo` / `--auto` flags to auto-approve `ask` prompts.
- Session-scoped "Allow always" promotion.
- Zero dependencies, plain JS.
