# pi-igotchu

[![npm](https://img.shields.io/npm/v/pi-igotchu?style=flat)](https://www.npmjs.com/package/pi-igotchu)
[![license](https://img.shields.io/npm/l/pi-igotchu?style=flat)](./LICENSE)
[![stars](https://img.shields.io/github/stars/jerryfan/pi-igotchu?style=social)](https://github.com/jerryfan/pi-igotchu)

A **context drift monitor** for [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).
It watches for “we’re no longer working on the same thing” and nudges you *only when confidence is high*.

Design constraints (why it feels non-annoying):
- command: **`/yo`** (short, memorable)
- nudges only when **confidence ≥ 95**
- no editor injection / no autocomplete prefill
- clear, compact footer signal: `<glyph> yo`

If you want more of this kind of “small, sharp” Pi tooling, star the repo.

---

## Install

Install with **Pi**, not npm:

```bash
pi install npm:pi-igotchu
```

Then in Pi:

```text
/reload
/yo status
```

Local dev install (from a checkout):

```bash
pi install -l <path-to-pi-igotchu>
```

---

## Quickstart

- check current drift: `/yo`
- show detailed status: `/yo status`
- see a report overlay: `/yo report`
- enable/disable: `/yo on` / `/yo off`
- set gates:
  - confidence gate: `/yo threshold 95` (95–99)
  - drift gate: `/yo nudge 85` (0–100)

---

## What it looks like (footer)

`<glyph> yo`

- `✕ yo` disabled/error
- `○ yo` low drift
- `◔ yo` mild drift
- `◑ yo` medium drift
- `◕ yo` high drift
- `● yo` nudge-ready (drift high AND confidence ≥ threshold)

---

## Commands

- `/yo` (quick status)
- `/yo status`
- `/yo report`
- `/yo on|off`
- `/yo threshold <95-99>`
- `/yo nudge <0-100>`
- `/yo model show|auto|pin <provider/model>`
- `/yo sync` (write `.igotchu.md` now)
- `/yo deep` (manual deep analysis using your current chat model)
- `/yo reset`

---

## Config

Config file:
- `~/.pi/agent/igotchu.json`

Common keys:
- `threshold` (95–99): confidence gate for user-facing nudges
- `nudgeThreshold` (0–100): drift gate for user-facing nudges

---

## Files

- config: `~/.pi/agent/igotchu.json`
- state: `~/.pi/agent/state/igotchu.json`
- project memory: `<repo>/.igotchu.md` (includes a preserved user-notes block)

---

## Troubleshooting

- **Installed but `/yo` is unknown**
  - run `/reload` (or restart Pi)
- **No footer signal**
  - install a footer renderer (recommended: `pi-oneliner`)

---

## Development

Local dev loop:

```bash
# in your checkout
pi install -l .
```

Then:

```text
/reload
/yo status
```

---

## For extension authors

Footer integration tip (recommended with `pi-oneliner`):
- status key: `yo`
- value format: `<glyph> yo`

Example (oneliner allowlist):

```json
{
  "status": {
    "right": {
      "mode": "allowlist",
      "allow": ["yo"]
    }
  }
}
```

---

## For maintainers

Release checklist:
- update `CHANGELOG.md`
- bump version: `npm version patch`
- `npm publish`

---

## License

MIT
