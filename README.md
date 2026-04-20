# igotchu (HARD CUTOVER → `/yo`)

`igotchu` is now a **context drift monitor** for Pi.

- Command: **`/yo`**
- Footer token: **`<glyph> yo`** (yo only)
- **Nudges only when confidence ≥ 95**
- **Autocomplete/prefill is removed** (no editor injection)

## Install (npm)

> Important: install with `pi install`, **not** `npm install`.

```bash
pi install npm:@jrryfn/igotchu
```

Local dev install:

```bash
pi install -l /c/code/pi/public/pi-extensions/igotchu
```

Then in Pi:

```text
/reload
/yo status
```

## Footer glyphs

`<glyph> yo`

- `✕ yo` disabled/error
- `○ yo` low drift
- `◔ yo` mild drift
- `◑ yo` medium drift
- `◕ yo` high drift
- `● yo` nudge-ready (drift high AND confidence ≥ threshold)

## Commands

- `/yo` (quick status)
- `/yo report` (overlay report)
- `/yo on|off`
- `/yo threshold <95-99>`
- `/yo nudge <0-100>`
- `/yo model show|auto|pin <provider/model>`
- `/yo sync` (write `.igotchu.md` now)
- `/yo deep` (manual deep analysis using your current chat model)
- `/yo reset`

## Files

- Config: `~/.pi/agent/igotchu.json`
- State: `~/.pi/agent/state/igotchu.json`
- Project memory: `<repo>/.igotchu.md` (includes a preserved user-notes block)
