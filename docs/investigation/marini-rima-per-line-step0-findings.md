# Marini/Rima Per-Line Extraction — Step 0 Findings + Prompt Fix

Run: 2026-06-01
Branch: `marini-rima-per-line-fix` (commit `fd63d5d`)
Method: `POST /api/admin/inspect-invoice-columns` against Laweka 3174, Eventcenter 2948, Eventcenter 2975. Sonnet plain-text walkthrough, no tool_use.

## Three-line headline

1. **The Marini/Rima passthroughs use a markup pattern the original rebill rule didn't model**: page 1 has a single "Levererat från Marini/Rima 2025 MM" line where `Lev ant = 1.10` is a **10% distributor markup multiplier** (NOT a quantity), `à-pris` = the underlying supplier cost, and `Summa = à-pris × 1.10` = the invoice header. Page 2 then itemizes Marini/Rima's underlying sales statistics with columns `Artikelnr | Namn | Antal | EUR | SEK`. Per-row totals on page 2 reconcile to the PRE-MARKUP supplier cost (≈ 91% of invoice header for 1.10 markup), not directly to the invoice header.
2. **Two sub-cases on page 2 layout that depend on the invoice:** for 3174 the SEK column IS populated per row (sum = 94,836.58 SEK = pre-markup cost), and an extractor should use it × markup. For 2948 + 2975 the SEK column is BLANK per row — only the EUR column carries per-row values, with an FX rate (~11,15) printed at the top of page 2. Extractor uses EUR × FX × markup. Both reconcile to header within öresavrundning when done correctly.
3. **The 8% extraction signature in the prior dry-run is now fully explained.** The model was reading EUR row values as if they were already SEK and missing BOTH conversions (FX + markup). 1 / (11 × 1.10) ≈ 0.0826 — that's exactly the 8.2% under-extraction ratio observed. With the correct conversions, row sums equal the invoice header to within öresavrundning.

## The full structure (from Sonnet's expert walkthrough)

### Page 1 (Laweka or Eventcenter SEK invoice to the buyer)

Single line in the line-item table:

| Benämning | Lev ant | Enhet | À-pris | Summa |
|---|---|---|---|---|
| Levererat från Marini/Rima 2025 09 | 1,10 | st | 94 836,58 | 104 320,24 |

`Lev ant = 1.10` is the markup multiplier, NOT a quantity. `À-pris = supplier cost`, `Summa = à-pris × markup = header total`.

### Page 2 (Marini/Rima's "Försäljningsstatistik" — the underlying detail)

Columns `Artikelnr | Namn | Antal | EUR | SEK`. Plus an FX rate at the top (e.g. "EUR→SEK 11,0565") and grand totals.

**For Laweka 3174 (SEK column populated per row):**

| # | Article | Antal | EUR | SEK |
|---|---|---|---|---|
| 1 | Mozzarella per pizza Julienne | 55,00 | 6,96 | 76,89 |
| … | … | … | … | … |
| n | Pall Farina di riso Scotti 25 kg | varies | … | … |
| **TOTAL** | — | — | **8 577,45** | **94 836,58** |

Sum of 46 rows' SEK column = 94,836.58. That × 1.10 markup = 104,320.24 = invoice header.

**For Eventcenter 2948 + 2975 (SEK column BLANK per row, only EUR populated):**

| Artikelnr | Namn | Antal | EUR | SEK |
|---|---|---|---|---|
| ABB1 B1 | Mozzarella per pizza Julienne | 50 | 348 | *(blank)* |
| FAP1 C1 | Parmigiano Reggiano DOP | 23,16 | 442,36 | *(blank)* |
| … | … | … | … | … |
| **TOTAL row at top of page 2** | — | — | **4 750,98** | **53 020,94** |

Sum of EUR column = 4,750.98 = page-2's EUR grand total. × FX rate 11.16 = 53,020.94 SEK (supplier cost). × 1.10 markup = 58,323.03 = invoice header.

### Math reconciliation

| Invoice | Page-2 EUR sum | × FX | = Page-2 SEK | × 1.10 markup | = Header |
|---:|---:|:---:|---:|:---:|---:|
| 3174 | 8 577,45 | × 11.0565 | = 94 836,58 | × 1.10 | = **104 320,24** ✓ |
| 2948 | 7 357,71 | × 11.15 | = 82 038,47 | × 1.10 | = **90 242,32** ✓ |
| 2975 | 4 750,98 | × 11.16 | = 53 020,94 | × 1.10 | = **58 323,03** ✓ |

All three reconcile to within öresavrundning of the invoice header. The math is deterministic.

## Why the prior extraction failed

Pre-rebill-rule: the old rule classified these as rebills (because the page-1 line references another supplier), returned the single summary line, and stored it. That's the 1-row legacy state in the queue.

Post-rebill-rule (the dry-run from earlier today): the new rule correctly identified the page-2 itemization as the catalogue detail. But the model read each page-2 row's `EUR` value AS IF it were `SEK`, missing both the FX conversion AND the markup. Row sums totalled 8.2% of header (`1 / (11.15 × 1.10) ≈ 0.082`). The `total_mismatch` guard correctly blocked the extraction — but Direction A still couldn't recover items.

This proves the safety floor was correctly catching bad data, AND that the prompt needed a specific sub-rule for this pattern.

## The prompt fix (committed as `fd63d5d`)

A new PASSTHROUGH-WITH-MARKUP sub-rule appended to the MULTI-INVOICE section:

1. Detect the page-1 markup from `Lev ant` on the summary line.
2. For each page-2 product row: use SEK column when populated; else use EUR × page-2 FX rate.
3. Multiply each per-row total by the markup → that's the buyer cost, stored in `row.total_excl_vat`.
4. Sum must reconcile to header within ~5% (the existing over_extraction + total_mismatch guards reject otherwise).

Worked examples for both sub-cases (SEK column populated, SEK column blank) are included verbatim in the prompt so the model has concrete reference.

`quantity` and `price_per_unit` on each row stay in the supplier's units (Antal as printed, unit from the product description). Only `total_excl_vat` carries the FX + markup so the catalogue engine derives per-unit buyer cost as `total/qty` at read time.

## Next step

Re-run the rebill-rule dry-run against the same 13-invoice set (5 passthroughs + 5 thin rebills + 3 baselines) and check:

| Direction | Check |
|---|---|
| A — passthroughs | Row sums must reconcile to header within öresavrundning (not just within the 5% over_extraction guard — actually clean). Specifically: Laweka 3174 = 104,320.24, Eventcenter 2902 ≈ 234,691, 2948 = 90,242, 2975 = 58,323, Laweka 3278 = -10,898. |
| B — rebills | No change expected. Frimurarholmen 3462 still blocked by over_extraction; others accepted with original single-line. |
| C — baselines | No regression. M&S 3598, 3586, Trädgårdshallen 3599 extract identically. |

The over_extraction guard at >5% over and total_mismatch at >5% under will catch any mis-application of the new sub-rule. Step 3 (real re-extraction recovering ~225 items) only proceeds if Direction A reconciles cleanly.

## What was NOT done

- No re-extraction triggered.
- No DB writes.
- No Step 2 dry-run run yet — pending the preview rebuild.
