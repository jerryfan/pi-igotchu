# pi-igotchu Release Plan (lean, npm-first)

## 1) Quality gate (manual, in a real pi session)

After installing and restarting pi:

```text
/yo status
/yo report
/yo threshold 95
/yo nudge 85
/yo model show
/yo sync
```

If `pi-i18n` is installed, verify locale switching:

```text
/lang zh-TW
/yo report
/lang zh-CN
/yo report
/lang ja
/yo report
```

Expected:
- `/yo` completions show localized descriptions
- overlay report strings are localized
- `.igotchu.md` headings are localized (user-notes markers preserved)

## 2) Pack + publish

From this folder:

```bash
npm pack --dry-run
npm publish
```

Install snippet:
- `pi install npm:pi-igotchu`
