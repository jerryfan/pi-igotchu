# igotchu SPEC (HARD CUTOVER → /yo)

**Quality target:** 95+/100  
**Version:** v2.0 (cutover)  
**Date:** 2026-04-20

---

## 1) Product statement

`igotchu` (package name) is now a Pi extension that exposes **`/yo`**, a **context drift monitor**.

It continuously (cheap-first) estimates **driftiness 0–100** for the current session/work and:

- shows a **one-token** footer status: `<glyph> yo`
- **nudges** (a single short notification) only when **confidence ≥ 95**
- never autocompletes, prefills, or injects editor text (autocomplete feature removed)

**Manual-only deep mode:** `/yo deep` uses the user’s **current chat model** for a one-off deeper analysis.

---

## 2) Confidence + nudge gates (hard)

- A user-facing **nudge** may only happen when:
  - `confidence >= threshold` (threshold clamp: **95–99**)
  - `drift >= nudgeThreshold` (0–100)
  - cooldown elapsed

Cheap model evaluations may still update internal drift state below 95; they just cannot nudge.

---

## 3) Footer/status (oneliner-compliant)

Status key: `yo`  
Rendered status text: `<glyph> yo`

Suggested meanings:

- `✕ yo` disabled or error
- `○ yo` low drift
- `◔ yo` mild drift
- `◑ yo` medium drift
- `◕ yo` high drift
- `● yo` nudge-ready (drift high **and** confidence ≥ threshold)

No numbers, no wrap, no verbose tails.

---

## 4) Commands (hard cutover)

Primary:
- `/yo` → quick status
- `/yo report` → overlay report
- `/yo on` | `/yo off`
- `/yo threshold <95-99>`
- `/yo nudge <0-100>`
- `/yo model show|auto|pin <provider/model>`
- `/yo sync` → write `.igotchu.md` now
- `/yo deep` → manual deep analysis (current chat model)
- `/yo reset` → reset runtime drift history + cooldown (keeps `.igotchu.md`)

Autocomplete feature is removed: there is no accept/delete injection behavior.

---

## 5) Models

- Default: auto-select cheapest viable text model (reasoning-preferred when available).
- Never changes the user’s active chat model.
- `/yo deep` uses `ctx.model` (the user’s current chat model).

---

## 6) Persistence + memory

- Config: `~/.pi/agent/igotchu.json`
- State: `~/.pi/agent/state/igotchu.json`
- Project memory: `<repo>/.igotchu.md`

All writes must be **atomic** (temp + rename). `.igotchu.md` includes a preserved user-notes region:

- `<!-- yo:user-notes:start --> ... <!-- yo:user-notes:end -->`

---

## 7) Veteran-practices checklist (required for 95+/100)

- `pi.storage.atomic.write.rename` for config/state/memory
- `pi.storage.mtime.cache.reads` for `.igotchu.md`
- `pi.command.completions.dynamic` for `/yo`
- `pi.ui.overlay.sidepane.workflow` for `/yo report`
- `pi.ui.custom.loader.abortable` for `/yo deep`
