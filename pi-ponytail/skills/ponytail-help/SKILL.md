---
name: ponytail-help
description: >
  Quick-reference card for all ponytail modes, skills, and commands.
  One-shot display, not a persistent mode. Trigger: /skill:ponytail-help,
  "ponytail help", "what ponytail commands", "how do I use ponytail".
---

# Ponytail Help

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

## Levels

| Level | Trigger | What changes |
|-------|---------|-------------|
| **Lite** | `/ponytail lite` | Build what's asked, name the lazier alternative in one line. |
| **Full** | `/ponytail full` | The ladder enforced: YAGNI → stdlib → native → one line → minimum. Default. |
| **Ultra** | `/ponytail ultra` | YAGNI extremist. Deletion before addition. Challenges requirements before building. |

Level sticks until changed or session end.

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | `/ponytail status` | Current level and default. Change level with `/ponytail <mode>`. |
| **ponytail-review** | `/skill:ponytail-review` | Over-engineering review: `L42: yagni: factory, one product. Inline.` |
| **ponytail-audit** | `/skill:ponytail-audit` | Whole-repo over-engineering audit: ranked list of what to delete. |
| **ponytail-debt** | `/skill:ponytail-debt` | Harvest `ponytail:` shortcut comments into a tracked ledger. |
| **ponytail-gain** | `/skill:ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | `/skill:ponytail-help` | This card. |

## Deactivate

Say "stop ponytail" or "normal mode". Resume anytime with `/ponytail <mode>` (e.g. `/ponytail full`).
`/ponytail off` also works.

## Configure Default Mode

Default mode = `full`, auto-active every session. Change it:

**Environment variable** (highest priority):
```bash
export PONYTAIL_DEFAULT_MODE=ultra
```

**Config file** (`~/.config/ponytail/config.json`, Windows: `%APPDATA%\ponytail\config.json`):
```json
{ "defaultMode": "lite" }
```

Set `"off"` to disable auto-activation on session start, activate manually
with `/ponytail <mode>` when wanted.

Resolution: env var > config file > `full`.

## Update

Pi packages update by reinstalling:

```bash
pi install npm:@bacnh85/pi-ponytail
```

Restart pi to load the new version.

## More

Full docs + examples: https://github.com/DietrichGebert/ponytail
