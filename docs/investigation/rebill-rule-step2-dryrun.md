# Rebill Rule — Step 2 Dry-Run Verdict (DO NOT APPLY)

Run: 2026-06-01
Branch: `rebill-rule-rewrite` (commit `b1add5f`)
Method: POST /api/admin/dry-run-rebill-rule against 13 invoices, two batches, ~100s + ~95s. No DB writes performed.

## Three-line headline

1. **Direction A (passthroughs to recover): MOSTLY FAILED.** 2 of 5 invoices (Laweka 3174, Eventcenter 2902 — the two biggest) returned ZERO rows because the model hit the `max_tokens: 4096` cap mid-extraction and the tool-use block never closed; tokens_output=4096 with empty `rows` array. 2 of 5 (Eventcenter 2948, 2975) extracted partial item lists summing to only ~8% of the invoice header (29 rows / 7,358 SEK against 90,242 header; 22 rows / 4,751 against 58,323). Only the credit note (3278) extracted correctly as a single-line summary. No invoice from Set A produced the clean "extract all items, sum to header" outcome the rewrite targets.
2. **Direction B (thin rebills to preserve): CATASTROPHIC REGRESSION on 3462.** The model extracted 15 items from Frimurarholmen 3462's attached Axfood receipt totalling **4,759.80 SEK** when the actual invoice (and the buyer's obligation) is **1,441.82 SEK** — 3.3× over-extraction. This is precisely the double-counting failure mode the original rule was protecting against. The reconciliation test in the new prompt didn't stop the model from enumerating an attached receipt whose items sum to MORE than the rebilled amount. 1 of 5 (3345) returned 0 rows. 1 of 5 (3315) correctly preserved the summary. 2 of 5 (2828, 3075) reconciled — but those might be legitimate full-receipt passthroughs, not regressions.
3. **Direction C (baselines): clean.** M&S 3598 (32→32 rows, 9,299 SEK reconciles), M&S 3586 (37→37 rows), Trädgårdshallen 3599 (31→31 rows, 2,931 reconciles). The rewrite doesn't damage normal multi-page extractions.

## Verdict: STOP. Do not apply. Two distinct failures need fixing before Step 3.

Per the prompt's HARD RULE: *"Apply only if Direction A recovers the items AND Direction B shows zero rebill regression."* Neither condition met.

## Per-invoice detail

### Set A — Passthroughs (5)

| inv | prev rows | new rows | new total | header | recon | tokens out | verdict |
|---:|---:|---:|---:|---:|:---:|---:|---|
| 3174 (Laweka) | 1 | **0** | 0 | 104,320 | ✗ | **4096 (CAP)** | Failed — token cap, no rows materialised |
| 2902 (Eventcenter) | 1 | **0** | 0 | 234,691 | ✗ | **4096 (CAP)** | Failed — token cap |
| 2948 (Eventcenter) | 1 | 29 | 7,358 | 90,242 | ✗ | 3293 | Partial — items extracted but only 8% of header |
| 2975 (Eventcenter) | 1 | 22 | 4,751 | 58,323 | ✗ | 2468 | Partial — items extracted but only 8% of header |
| 3278 (Laweka credit) | 1 | 1 | -10,898 | -10,898 | ✓ | 260 | OK — credit note correctly kept as summary |

The two biggest cases (3174 = 45 items expected; 2902 = even more — 234k SEK) hit the 4096 output-token cap. The model output a partial tool_use block that didn't parse to rows. The intermediate cases (2948, 2975) extracted SOME items but stopped well before all of them — possibly because the model interleaved reasoning text with tool output and ran out, or because it produced rows that the validator rejected.

### Set B — Thin rebills (5)

| inv | prev rows | new rows | new total | header | recon | sample 1st row | verdict |
|---:|---:|---:|---:|---:|:---:|---|---|
| 2828 (Frimurarholmen) | 1 | 4 | 411 | 411 | ✓ | MEL GURKA 2,55KG | Items reconcile to header — Frimurarholmen rebilled the FULL Axfood receipt this time. Not a regression — but means the Step 0 classification of "thin rebill" was wrong for this row. |
| 3075 (Frimurarholmen) | 1 | 1 | 531 | 531 | ✓ | KON CARAMELTRYFFEL 1KG LV qty=7 | Single product, reconciles. Similar — the Axfood receipt was effectively one product. |
| 3315 (Frimurarholmen) | 1 | 1 | 531 | 531 | ✓ | Axfood 0020773958 (summary kept) | Model kept the summary line. Old behaviour preserved. |
| 3345 (Frimurarholmen) | 1 | **0** | 0 | 782 | ✗ | (empty) | Failed — 0 rows. Model couldn't make a decision. |
| 3462 (Frimurarholmen) | 1 | **15** | **4,759.80** | **1,441.82** | ✗ | NAP SALAMICA 2,3KG, KIK SOYA 1L, GIL BOLLAR 750G… | **CATASTROPHIC**: extracted 3.3× the invoice value. The attached Axfood receipt has items summing to 4,759 but Chicce only owes 1,442 — Frimurarholmen rebilled ~30% of what's on the receipt. Model failed to apply the reconciliation test. |

### Set C — Baselines (3)

| inv | prev rows | new rows | new total | header | recon | verdict |
|---:|---:|---:|---:|---:|:---:|---|
| 3598 (M&S) | 32 | 32 | 9,299 | 9,299 | ✓ | Identical — no regression |
| 3586 (M&S) | 37 | 37 | 13,948 | 0 | — | Header total absent; row count identical |
| 3599 (Trädgårdshallen) | 31 | 31 | 2,931 | 2,931 | ✓ | Identical — no regression |

## Root-cause analysis

### Problem 1: max_tokens=4096 is too tight for large itemizations

A 45-row passthrough (Laweka 3174) needs ~45 × 150 tokens/row ≈ 6,750 output tokens minimum. Eventcenter 2902 (234k SEK ÷ ~300 SEK/avg item ≈ 750 items? or maybe 50-60 items at higher prices) needs more. At 4096 max_tokens the model gets cut off mid-extraction and the tool_use block fails to parse → 0 rows.

The current `lib/inventory/pdf-extractor.ts:811` has `max_tokens: 4096`. This was fine for the OLD rule because the model returned 1-row summaries on these invoices. The new rule requires returning every item, so the cap is now the bottleneck.

Haiku 4.5 supports up to 8K standard, 64K with beta header. Recipe-authoring's ai-suggest already uses 48000 max_tokens, so the path exists.

**Fix:** bump `max_tokens` to (suggested) 16384 minimum — enough for 100-item invoices.

### Problem 2: Reconciliation rule not strong enough — model still enumerates oversized attachments

Frimurarholmen 3462 is the precise failure the original rule was protecting against: page-1 single rebill line (1,442 SEK) + attached Axfood receipt with MORE items (4,760 SEK). New rule said *"if the page-2 items DON'T sum to the page-1 line, keep summary and ignore attachment"*. Model still extracted the 15 attachment items.

Why the rule didn't fire:
- The model is biased toward extracting items when it sees them. The reconciliation test in the prompt is a passive instruction; the model doesn't ACTIVELY sum and compare before deciding.
- The new rule's case-A description is concrete ("extract all items"). The case-B description ("ignore attachment") competes for the model's attention against the strong "extract every product row" instruction earlier in SYSTEM_PROMPT.

**Fix candidates:**
- (a) Strengthen the rule with an explicit decision-tree the model has to walk through: "Step 1: identify the page-1 summary line. Step 2: sum the page-2 items. Step 3: if |sum - summary| / summary > 5%, the attachment is NOT a passthrough — return ONLY the page-1 line." Force the order of operations.
- (b) Add a server-side validator: after extraction, if total_extracted > header_total × 1.1 (signature of pulling in oversized attached receipt), reject the extraction with an `over_extraction` warning and fall back to single-row summary.
- (c) Per-supplier whitelist for known-passthrough suppliers (Laweka, Eventcenter at Chicce) — the rule only fires on them. Bypasses the model's bias entirely.

Cleanest path is (a) + (b) belt-and-braces. (c) is a fallback if the model can't be made reliable.

### Problem 3: Partial extraction on 2948, 2975

These extracted 22-29 rows out of an expected ~45+, summing to ~8% of header. The model didn't hit the token cap (output 3293 / 2468 — well under 4096) but also didn't get all the items. Why?

Likely cause: the model gave up early after extracting enough to feel "done" without verifying the sum-to-header match. The decision tree in (a) above would catch this too — if sum != header within 5%, the model knows it's incomplete and should either retry or flag.

Alternative: a post-extraction sanity check could trigger Haiku→Sonnet escalation in this case (already exists in `pdf-extractor.ts:137-155`), but the cascade trigger may not currently fire on partial-extraction-of-passthrough.

## Recommended next iteration

1. Bump `max_tokens` from 4096 → 16384.
2. Rewrite the rule with an explicit decision-tree (sum → compare → decide), instead of leaving reconciliation as a passive instruction.
3. Add a post-extraction over-extraction guard: if `total_extracted > total_header × 1.1`, fail validation with `over_extraction` warning (would catch the 3462 case at validator time even if the prompt slip-throughs).
4. Re-run the same 13-invoice dry-run. Apply Step 3 only if Direction A (3174, 2902, 2948, 2975) recovers full itemizations AND Direction B (especially 3462) is back to single-line.

## Token / cost cost summary

13 invoices, ~3M total input tokens, ~32k output. Estimated Anthropic spend: ~$0.05. Negligible.

## What was NOT done

- No DB writes.
- No real re-extraction triggered.
- No prompt rewrite iteration shipped (this verdict precedes that work).
- Step 3 (real re-extraction recovering ~225 items) NOT performed — gates on a successful Direction A + clean Direction B that this iteration didn't achieve.

## Sample evidence (sample_rows from the dry-run)

### Laweka 3174 — empty (token cap)
```
rows_count: 0
total_extracted: 0
tokens_output: 4096  ← cap hit
sample_rows: []
```

### Frimurarholmen 3462 — over-extracted (regression)
```
rows_count: 15
total_extracted: 4759.80   ← THIS
total_header:    1441.82   ← VS THIS — 3.3× over
sample_rows: [
  { "NAP SALAMICA 2,3KG NAPOLIVV", qty=1.888, unit=KG, total=337.95 },
  { "KIK SOYA 1L PET", qty=1, total=72.9 },
  { "GIL BOLLAR 750G GILLE 24P", qty=1, total=64.9 },
  { "GIL PUNSCHRULLAR 630G", qty=1, total=67.9 },
  { "PAPRIKA RÖD", qty=1.07, unit=KG, total=56.6 },
  …
]
```
The Frimurarholmen invoice only billed Chicce 1,441.82 SEK total. Extracting the 4,759.80 SEK worth of Axfood receipt items would record 3,318 SEK of goods Chicce did not receive (Frimurarholmen kept those for other tenants or for itself).
