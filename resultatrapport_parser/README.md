# Resultatrapport Parser

Parser for Swedish "Resultatrapport" PDFs (Visma export). Handles two layouts:
- **Yearly per-month** (13 columns: `2501..2512` + `Ack`, values in tkr)
- **Monthly per-period** (3 columns: `Period` / `Ackumulerat` / `Period fg år`, values in kr)

Auto-detects the format. Validates every extraction against the report's own
`Summa nettoomsättning` row.

## Quick start

```bash
pip install -r requirements.txt
python cli.py path/to/Resultatrapport.pdf
python cli.py path/to/Resultatrapport.pdf --csv out.csv
python cli.py path/to/Resultatrapport.pdf --validate-only
```

## Programmatic use

```python
from extract import extract
from categorize import categorize, reconcile

rows, columns = extract("Resultatrapport.pdf")
agg = categorize(rows, columns)
ok, recon = reconcile(rows, agg, columns)
assert ok, recon
```

## For agents (Claude Code)

Read **`CLAUDE.md`** before modifying anything. It documents:
- The two report layouts and how to detect them
- Why text-line PDF parsing fails (three traps: thousand-space separator,
  vertical wrapping, embedded numbers in labels)
- The geometry-based extraction approach
- VAT-based categorization rules
- Reconciliation invariants

## Tests

```bash
python tests/test_smoke.py
```

## Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Agent instructions — read this first |
| `extract.py` | Format-agnostic PDF extraction |
| `categorize.py` | VAT-based revenue/cogs split (food / drinks / takeaway) |
| `cli.py` | Command-line entry point |
| `tests/test_smoke.py` | End-to-end regression tests |
| `tests/expected.py` | Known-good reference values |

## Categorization (`CATEGORY_MAP` in `categorize.py`)

| Account | Bucket | Category | Notes |
|---------|--------|----------|-------|
| 3010 | revenue | food | Avdrag mat personal (staff meals) |
| 3051 | revenue | drinks | 25 % VAT — alcohol |
| 3052 | revenue | food | 12 % VAT — dine-in food |
| 3072 | revenue | takeaway | Wolt / Foodora |
| 3740 | revenue | rounding | Öres- och kronutjämning |
| 4000, 4010 | cogs | food | General/food inventory |
| 4011 | cogs | drinks | Alcohol inventory |
| 6050 | cogs | takeaway | Platform commission |

Add new accounts here as the chart of accounts evolves. The reconciliation
will fail and tell you exactly which column is off if a new revenue account
appears that isn't mapped.
