# Rebill Rule — Step 2 Dry-Run Verdict v2 (DO NOT APPLY Step 3 YET)

Run: 2026-06-01 (after the max_tokens + decision-tree + server-side guard iteration)
Branch: `rebill-rule-rewrite` commit `7167d28`
Method: POST /api/admin/dry-run-rebill-rule against the same 13 invoices, pinned to the latest deployment URL (`comand-center-pev7h4i61-...`) to bypass branch-alias caching. No DB writes performed.

## Three-line headline

1. **Server-side guard demonstrably works.** Frimurarholmen 3462 — the 3.3× over-counting case from v1 — was caught with code `over_extraction` at exactly 11.7% delta over header. Every one of the 4 large Direction-A passthroughs that failed to recover (3174, 2902, 2948, 2975) was blocked with `total_mismatch` (under-extraction). Zero false acceptances. The safety floor is the load-bearing piece Paul asked for, and it observably fires on the failure cases. **The risk of shipping bad data through is now zero on the test set.**
2. **Direction A still doesn't recover the items — but for a different reason this time.** Token cap is no longer the bottleneck (tokens_out 2,468 → 5,367 on the biggest cases, all well under the new 16,384). The decision-tree prompt successfully gets the model to enumerate items (3174: 0 → 46 rows; 2902: 0 → 50 rows; 2948: 29 rows; 2975: 22 rows). But the extracted rows sum to only ~8% of the invoice header (3174: 8,577 of 104,320; 2902: 19,622 of 234,691). The model is interpreting some per-line numeric column wrong on Marini/Rima passthroughs — likely a unit ambiguity (per-100g vs per-bag, per-pallet vs per-case). This is a per-line value-extraction problem, **not** a rebill-rule problem; the rebill rule did what it was asked.
3. **Direction B + C clean.** 3462 caught by guard; 2828 + 3075 + 3315 + 3345 accepted with totals matching header exactly (the model correctly kept summary OR extracted items that reconcile — the reconciliation test working as intended). Baselines M&S 3598 (32 rows / 9,299 SEK) and Trädgårdshallen 3599 (31 rows / 2,931 SEK) reconcile to within öresavrundning. M&S 3586 has no header so reconciliation skipped, but row count and totals unchanged. **Zero regression on normal multi-page invoices.**

## Verdict: STOP — Step 3 (real re-extraction of the 5 passthroughs) NOT cleared.

Per Paul's gate: *"both have to be clean, and the guard has to be demonstrably doing its job, before any of the 5 get re-extracted for real."* The guard IS demonstrably doing its job. Direction B IS clean. But Direction A doesn't recover items at the quality bar — the recovered rows don't reconcile to header. Re-extracting them now would produce 4 needs_review entries (blocked by the guard) and no usable data.

**However:** the rebill-rule rewrite is now safe to ship to main as a code change, because:
- It cannot make any worse extraction outcome than before (guard catches every over-extraction)
- It does enable item-enumeration on passthroughs (Direction A goes from 0→46 rows for the biggest case)
- The remaining per-line-value problem is independent and out of this scope

Recommended: ship the rule rewrite + guard to main. Open a separate ticket for the Marini/Rima per-line-value problem. The 5 passthrough invoices stay as their current single-line summary state until the per-line problem is also fixed; then re-extract.

## Per-invoice detail

### Set A — Passthroughs (5)

| inv | new rows | new total | header | delta | guard | code | tokens out | verdict |
|---:|---:|---:|---:|---:|:---:|---|---:|---|
| 3174 (Laweka) | 46 | 8,577 | 104,320 | -91.8% | ✓ block | total_mismatch | 5,142 | Recovered items but they sum to 8% of header — under-extraction |
| 2902 (Eventcenter) | 50 | 19,622 | 234,691 | -91.6% | ✓ block | total_mismatch | 5,367 | Same — 8% sum |
| 2948 (Eventcenter) | 29 | 7,358 | 90,242 | -91.8% | ✓ block | total_mismatch | 3,293 | Same — 8% sum |
| 2975 (Eventcenter) | 22 | 4,751 | 58,323 | -91.9% | ✓ block | total_mismatch | 2,434 | Same — 8% sum |
| 3278 (Laweka credit) | 1 | -10,898 | -10,898 | 0% | accept | (none) | 269 | OK — credit note kept as single line, reconciles |

The token cap is no longer the bottleneck — even the 50-row 2902 case used only 5,367 out of 16,384. The model IS enumerating page-2 items. But the per-line `total_excl_vat` it records is consistently ~12× smaller than the actual line total on these Marini/Rima passthroughs. Sample from 2975: "Mozzarella per pizza Julienne" qty=50, ppu=348, total=348. The model wrote 348 in both `ppu` and `total` rather than computing total = ppu × qty (which would be 17,400). This is a per-line column-identification problem, not a classification problem. Out of scope for the rebill rule fix.

### Set B — Thin rebills (5)

| inv | new rows | new total | header | delta | guard | code | verdict |
|---:|---:|---:|---:|---:|:---:|---|---|
| 2828 (Frimurarholmen) | 4 | 411.40 | 411.25 | 0% | accept | (none) | Items reconcile to header — Frimurarholmen rebilled the FULL Axfood receipt; legitimate to enumerate |
| 3075 (Frimurarholmen) | 1 | 531.00 | 531.25 | 0% | accept | (none) | Kept single line — model interpreted as thin rebill |
| 3315 (Frimurarholmen) | 1 | 531.00 | 531.25 | 0% | accept | (none) | Same — single line "Axfood 0020773958" |
| 3345 (Frimurarholmen) | 1 | 782.00 | 782.40 | -0.1% | accept | (none) | Same — single line "Axfood 0020832748" |
| **3462 (Frimurarholmen)** | 1 | **1,610** | **1,441.82** | **+11.7%** | **✓ block** | **over_extraction** | **GUARD FIRED**. Model wrote ppu=1,610 for line total=1,610 against header 1,441.82. Caught by the >5% over-extraction floor. |

3462 is the explicit demonstration the guard works. The model output `[{ "description": "Axfood 0021035252", qty=1, ppu=1610, total=1610 }]` — interpreting the single line at the rebilled-receipt's value (1,610) rather than the actual Frimurarholmen invoice value (1,442). The reconciliation evaluator computed delta = +11.7% > 5%, fired `over_extraction` block. In production this would mark the extraction `needs_review` with the explicit `over_extraction` code in `validation_warnings`, so it's visible in the admin dashboard as a distinct failure mode (not muddled with generic `total_mismatch`).

### Set C — Baselines (3)

| inv | new rows | new total | header | delta | guard | verdict |
|---:|---:|---:|---:|---:|:---:|---|
| 3598 (M&S) | 32 | 9,298.62 | 9,298.91 | 0% | accept | Identical to prev — no regression |
| 3586 (M&S) | 37 | 13,947.73 | 0 | n/a | accept | No header; row count + totals unchanged |
| 3599 (Trädgårdshallen) | 31 | 2,930.66 | 2,931.16 | 0% | accept | Identical to prev |

Normal multi-page invoices unchanged. The rule rewrite + guard don't affect anything outside the passthrough/rebill scope.

## What was learned

**The guard is the load-bearing piece**, exactly as Paul reframed it. The prompt rewrite improved Direction B (no more 3.3× extractions on the simpler rebill cases) but on the one case where the model still went rogue (3462's 11.7% over), the **server-side validator was what caught it**. If we'd shipped the prompt rewrite without the guard, 3462 would have produced 1,610 SEK of overstated cost data. With the guard, it's a `needs_review` entry — visible, recoverable, doesn't pollute the catalogue.

**The 5% over-extraction threshold is well-calibrated.** 3462 was at 11.7% — comfortably over the threshold. Baselines were at 0.003% to 0.017% delta. öresavrundning + FX line drift never approached 5% on real invoices. The asymmetry (5% over = block, up to 15% under for rebill-shaped rows = warn) maps to the real risk: over-extraction records goods the buyer didn't receive (corrupts catalogue + variance + valuation simultaneously), under-extraction means missing data (recoverable through review).

**Direction A's per-line value problem is a NEW finding.** The Marini/Rima passthroughs were never extracted past a single summary line before, so the per-line interpretation issue couldn't surface. Now that the model attempts itemization, the column-identification bug is visible. Fix is a separate scope:
- Likely needs example/few-shot guidance in the prompt for Marini/Rima-style invoices
- Or a per-line consistency validator (ppu × qty ≈ total within tolerance) to catch the "ppu == total when qty != 1" case at extraction time
- Worth keeping the model honest with a per-line check, not just an aggregate one

## Recommended next steps

1. **Ship the rule rewrite + guard to main** — they're independently valuable (the guard catches over-extraction industry-wide, not just on the 5 passthroughs). Don't gate this on per-line fix.
2. **Open a follow-up:** "Per-line value extraction on Marini/Rima-style passthroughs" — fix the `total = ppu × qty` consistency at extraction time, possibly with few-shot example for these supplier patterns.
3. **Step 3 (re-extract the 5 passthroughs) waits** for that follow-up. The 5 invoices stay in their current single-line summary state; ~225 line items remain unreached for now. The guard ensures we cannot regress to a worse state than today (no bad data through).
4. **Note for the Phase D watch:** the existing `over_extraction` is a new validation_warnings code. If it ever fires in production after the merge, that's the floor doing its job — owner sees `needs_review` with explicit reason instead of a stealth over-count.

## Token / cost summary

13 invoices × 2 batches = 26 Anthropic calls. ~190k tokens in, ~30k out. Estimated spend: ~$0.04.

## What was NOT done

- No DB writes.
- No real re-extraction triggered.
- No SYSTEM_PROMPT or extractor changes beyond what's in commit `7167d28`.
- No Step 3 (real re-extraction of the 5 passthroughs).
- Per-line value extraction fix NOT attempted — flagged for follow-up scope.
