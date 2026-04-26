# Resultatrapport Parser — Agent Instructions

You are working with a parser for **Swedish "Resultatrapport" PDFs** exported from Visma. There are **two report layouts** with different structures, and they require different rules. Read this file fully before touching extraction or categorization code.

## TL;DR — the rules you must not break

1. **Never parse these PDFs by extracting text and splitting on whitespace.** That will silently produce wrong numbers. Use coordinate-based extraction via `pdfplumber.extract_words()` — see "Why text-line parsing fails" below.
2. **Auto-detect which of the two formats you are looking at** by inspecting the column-header words. Don't ask the user.
3. **Numbers are Swedish-formatted**: `1 644 159,94` is one number = 1644159.94. Space is a thousand separator, comma is the decimal point.
4. **Always run the reconciliation check** (sum of categorized revenue vs. `Summa nettoomsättning` row) before reporting any extracted figures. If it doesn't tick to ≤ 0.05, something is wrong — do not silently ship the result.
5. **Categorization is by VAT rate, not by guessing from labels**: 12 % = food, 25 % = drinks/alcohol, Wolt/Foodora = takeaway. The map lives in `categorize.py::CATEGORY_MAP`.

---

## The two formats

The same business uses both. They are produced by the same software (Visma) but at different reporting cadences.

### Format A — Yearly per-month report
- File name pattern: `Resultatrapport_<year>_12_mån*.pdf`
- Header row contains the tokens: `2501 2502 2503 … 2512 Ack`
  (year-month codes: `25` = year 2025, `01` = January, etc.)
- **13 numeric columns**: 12 months + accumulated year-to-date
- **Values are in tkr** (thousands of SEK), one decimal place: `883,7` means 883 700 SEK
- Detected by: presence of any of the month tokens above near the top of page 1 (`top < 100`)

### Format B — Monthly per-period report
- File name pattern: `Resultatrapport_<YYMM>.pdf` (e.g. `Resultatrapport_2602.pdf` = Feb 2026)
- Header row contains: `Period   Ackumulerat   Period fg år`
- **3 numeric columns**:
  - `period` — the current month
  - `ackumulerat` — year-to-date
  - `period_fg_år` — same period in the previous year (for comparison)
- **Values are in full kr**, two decimal places: `923 120,80` = 923 120.80 SEK
- Detected by: presence of the word `Ackumulerat` on the page

If you cannot detect either format, fail loudly. Do not guess.

---

## Why text-line parsing fails

If you call `page.extract_text()` and split lines on whitespace, you will hit three traps that are nearly invisible in the output:

### Trap 1 — Thousand-separator spaces are real spaces
Swedish numbers use a space as the thousand separator. The PDF stores this as an actual space character, so `1 207,3` arrives from `extract_words()` as **two separate word objects**: `'1'` then `'207,3'`. A regex like `line.split()` will treat them as two values, shifting every subsequent column to the wrong slot.

### Trap 2 — Vertical wrapping in narrow columns
When a value is too wide for its column (e.g. an Ack total of `11 497,0` in the yearly format), the digits split across two visual lines: `'11'` floats slightly above the row, `'497,0'` slightly below it. They are still in the same column geometrically (same `x1`), but text-line iteration sees them as orphans on different rows entirely.

### Trap 3 — Numbers inside labels look like values
Examples: `4535 Inköp av tjänster från annat EU-land, 25 %` (the "25" mid-label), `Arbetsgivaravgifter 31,42 %` (the "31,42"), and 4-digit account numbers like `4010` at the start of every row. None of these are values, but a naive numeric-detector will grab them.

**The fix for all three: use word coordinates.** Group words by their `x1` (right edge) into columns defined by the header positions. The orphan thousand-prefix `'1'` lands in the correct column because its right edge falls inside that column's interval. Wrapped tokens land in the same column despite different `top` values, because we use a `±8 pt` y-tolerance when bucketing words to a row.

---

## Architecture

Two small modules, one CLI:

```
extract.py     → format-agnostic PDF → rows + columns
categorize.py  → rows → revenue/cogs split by food/drinks/takeaway
cli.py         → command-line wrapper around both
```

The extractor doesn't know about restaurants. The categorizer doesn't know about PDFs. Keep them separate when extending.

### Extractor contract
```python
from extract import extract
rows, columns = extract("path/to/report.pdf")
# rows:    list of {"account": "3052", "label": "...", "values": {col: float|None}}
# columns: list of column labels in left-to-right order
```

For Format A, `columns == ["2501", "2502", …, "2512", "Ack"]`.
For Format B, `columns == ["period", "ackumulerat", "period_fg_år"]`.

### Categorizer contract
```python
from categorize import categorize, reconcile, CATEGORIES
agg = categorize(rows, columns)
# agg: {(bucket, category): {col: value}}, e.g. agg[("revenue","food")]["2503"]
ok, diffs = reconcile(rows, agg, columns)
# ok: bool, diffs: per-column reconciliation results
```

---

## Categorization rules — by VAT rate

These mappings are based on Swedish restaurant accounting conventions. **Do not deviate from them without a specific business reason.**

| Account | Bucket  | Category | Why |
|---------|---------|----------|-----|
| 3010    | revenue | food     | Avdrag mat personal — staff meal value, food-side |
| 3051    | revenue | drinks   | 25 % VAT — alcohol & other 25%-rated drinks |
| 3052    | revenue | food     | 12 % VAT — dine-in food |
| 3072    | revenue | takeaway | Wolt / Foodora — takeaway channel |
| 3740    | revenue | rounding | Öres- och kronutjämning |
| 4000    | cogs    | food     | Inköp varor från Sverige |
| 4010    | cogs    | food     | General/food inventory |
| 4011    | cogs    | drinks   | Alcohol inventory |
| 6050    | cogs    | takeaway | Wolt/Foodora platform commission |

**When you encounter a new account number that doesn't appear in `CATEGORY_MAP`:**
1. Do **not** silently bucket it — leave it unmapped.
2. The reconciliation will flag the miss.
3. Look at the account name and VAT context, then add it to the map.
4. Re-run reconciliation to confirm.

**Caveat to surface to the user when relevant**: account 4010 commingles dine-in food cost and takeaway food cost (the books don't separate them). So the takeaway gross-margin calculation is overstated and dine-in food margin is understated. If the user wants a true split, allocate 4010 between food and takeaway in proportion to their respective revenues — but flag this as an estimate.

---

## Validation — non-negotiable

Every extraction must run reconciliation before the result is reported. The check:

```
sum of categorized revenue per column  ==  Summa nettoomsättning row, per column
```

within 0.05 (rounding tolerance). If any column fails, the extraction is suspect — do not present the figures as final. Common causes of failure:

- A new revenue account has appeared that isn't in `CATEGORY_MAP`.
- A page-bottom row was clipped by the footer guard (this should not happen with the current `top < page.height - 15`, but check if the layout changes).
- A value wrapped vertically and one half exceeded the `±8 pt` y-tolerance (rare; widen if needed).

For Format A, also cross-validate that the sum of all leaf-account rows per column equals the `BERÄKNAT RESULTAT` row. This is a stronger check that catches missing rows anywhere in the report.

---

## Common operations

### Extract a report
```bash
python cli.py path/to/report.pdf
```
Outputs JSON to stdout (rows + columns + categorized aggregates + reconciliation status).

### Just check it parses cleanly
```bash
python cli.py path/to/report.pdf --validate-only
```
Exits 0 on clean reconciliation, non-zero otherwise.

### Compare a Format-B `period_fg_år` column against the corresponding month in a Format-A report
This is a useful sanity check across formats. The Feb 2025 column (`2502`) of the yearly report should match the `period_fg_år` column of the Feb 2026 monthly report, within rounding (~0.5 tkr per row, since Format A rounds to tkr).

---

## Things you should not do

- **Do not regex over `extract_text()` output.** The thousand-space and wrap traps will get you.
- **Do not hardcode column x-positions.** The detector reads them from the header on every page; this stays robust if Visma tweaks the template.
- **Do not skip reconciliation** because "the numbers look right" — they may look right and be subtly wrong (the 1M-kronor missing-leading-digit bug is a real example we hit during development).
- **Do not categorize an unknown account** by guessing from its name. Add it to `CATEGORY_MAP` explicitly, with a comment.
- **Do not change the sign convention.** COGS values arrive negative from the PDF; the gross-margin formula is `revenue + cogs` (not `revenue - cogs`).

---

## File layout

```
resultatrapport_parser/
├── CLAUDE.md           ← this file
├── README.md           ← human-facing version
├── requirements.txt    ← pdfplumber>=0.11
├── extract.py          ← format-agnostic PDF extractor
├── categorize.py       ← VAT-based revenue/cogs classification
├── cli.py              ← command-line entry point
└── tests/
    ├── test_smoke.py   ← runs both formats end-to-end and checks reconciliation
    └── expected.py     ← known-good reference values
```

When you fix a bug or add a category, add a regression assertion to `test_smoke.py` so the next agent can't reintroduce the bug.
