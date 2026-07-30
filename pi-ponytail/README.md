# @bacnh85/pi-ponytail

**Lazy senior dev mode for your [Pi coding agent](https://pi.dev/).**

He says nothing. He writes one line. It works. Ponytail puts a deadpan senior
developer inside your Pi agent. Before writing code it climbs a ladder: does
this need to exist? (YAGNI) → already in the codebase? → stdlib? → native
platform? → installed dependency? → one line? → minimum that works.

A fork of [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)
adapted for the Pi harness.

---

## Install

```bash
pi install npm:@bacnh85/pi-ponytail
```

---

## Commands

| Command | What it does |
|---------|--------------|
| `/ponytail` | Enable the default mode (full unless changed) |
| `/ponytail lite\|full\|ultra\|off` | Set session intensity |
| `/ponytail status` | Show current and default mode |
| `/ponytail default lite\|full\|ultra\|off` | Persist the default across sessions |
| `/skill:ponytail-review` | Over-engineering review on the current diff |
| `/skill:ponytail-audit` | Whole-repo over-engineering audit |
| `/skill:ponytail-debt` | Harvest `ponytail:` shortcut markers into a ledger |
| `/skill:ponytail-gain` | Show measured-impact scoreboard (benchmark medians) |
| `/skill:ponytail-help` | Quick reference |

Deactivate: `stop ponytail` or `normal mode`. Resume with `/ponytail`.

---

## Intensity levels

| Level | What changes |
|-------|-------------|
| **lite** | Build what's asked, name the lazier alternative in one line. You pick. |
| **full** | The ladder enforced. Stdlib and native first. Shortest diff, shortest explanation. **Default.** |
| **ultra** | YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest. |
| **off** | Ponytail disabled for this session. |

---

## Default mode

Resolution order (first wins):

1. **Env var** — `PONYTAIL_DEFAULT_MODE=lite|full|ultra|off`
2. **Config file** — `$XDG_CONFIG_HOME/ponytail/config.json` or `~/.config/ponytail/config.json`
   ```json
   { "defaultMode": "full" }
   ```
3. **Built-in** — `full`

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

---

## License

MIT. Same as upstream.
