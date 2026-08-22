# Changelog

## 0.1.0

- Initial release — kernel extracted from pi-a2a's `/a2a-config` panel (design unchanged since a2a 0.3.0).
- Exports: `openConfigPanel`, `ConfigPanelModel`, `makeOnAction`, `row`, `toInt`, `applyRows`, `kindValue`, row-model types.
- `BuildRows<T>` generic row builder replaces pi-a2a's hardcoded `buildRows`; `title` option replaces the hardcoded "A2A Configuration" header.
- Kernel tests ported from pi-a2a against a generic fixture config.
