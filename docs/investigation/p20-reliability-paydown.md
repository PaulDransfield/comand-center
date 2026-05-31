# P2.0 Reliability Paydown — Ticket 1 SHIPPED, Ticket 2 PARKED

Run: 2026-05-31
Branch: `p20-reliability-paydown` (about to merge to main)

## Headline

**Ticket 1 — JSONB → columns: SHIPPED.** Zero Phase D effect (no live read paths parsed the JSONB). Pure plumbing for future P2.0-style operations and sync-cron data-model cleanliness.

**Ticket 2 — Cache re-warm: PARKED until after 2026-06-07 Phase D read.** Rescue ceiling is ~2,354 lines (1,860 Chicce + 494 Vero), which at Vero's scale is potentially a 22%+ shift in the exact signal Phase D is built to read. Injecting it mid-watch would confound the queue-drain signal we deliberately bought clean by sequencing the Gate-0 cleanups ahead of the watch. Don't move what you're measuring while measuring it.

## Ticket 1 — what shipped

### Code
- **`lib/fortnox/extract-voucher-ref.ts`** (NEW). Single source of truth for the SUPPLIERINVOICE-ref extraction. Documents the load-bearing filter: `Vouchers[]` contains both SUPPLIERINVOICE (booking) and SUPPLIERPAYMENT (payment) refs; only the former carries expense-row data. Mistaking one for the other would silently resolve every future join to the wrong voucher.
- **`app/api/cron/fortnox-supplier-sync/route.ts`** patched. Old code wrote `voucher_series: inv.VoucherSeries ?? null` reading a top-level field that doesn't exist in Fortnox's response shape — which is why the columns were 100% NULL despite the cron "writing" to them. Replaced with `...extractSupplierInvoiceVoucher(inv)` so the shared helper populates the columns from `Vouchers[]` on every future sync write.

### Data
- **`sql/p20-paydown-ticket1-backfill-APPLY.sql`** ran on 2026-05-31. Backfilled the existing `fortnox_supplier_invoices.voucher_series` + `voucher_number` columns (M098) from `raw_data.Vouchers` JSONB, scoped to Chicce + Vero.

### Verification — all four guards clean

| Check | Expected | Actual |
|---|---:|---:|
| V1 Chicce backfilled | 725 | **725** ✓ |
| V1 Vero backfilled | 995 | **995** ✓ |
| V1 Chicce still NULL (unrecoverable) | 23 | **23** ✓ |
| V1 Vero still NULL (unrecoverable) | 17 | **17** ✓ |
| V3 extracted ref is SUPPLIERPAYMENT (load-bearing) | 0 | **0** ✓ |
| V4 idempotency: still backfillable rows after run | 0 | **0** ✓ |

### Spot-check evidence

Five random backfilled rows pulled with their full `raw_data.Vouchers` array side-by-side with the extracted `(series, number)`. Three of the five carried both SUPPLIERINVOICE and SUPPLIERPAYMENT entries — in every case the extraction correctly picked the SUPPLIERINVOICE one:

```
invoice=9193 extracted=C/244
  → [{Number:244, Series:C, ReferenceType:SUPPLIERINVOICE}]                                     ✓

invoice=3542 extracted=D/519
  → [{Number:519, Series:D, ReferenceType:SUPPLIERINVOICE}]                                     ✓

invoice=3429 extracted=D/396
  → [{Number:396, Series:D, ReferenceType:SUPPLIERINVOICE},
     {Number:468, Series:E, ReferenceType:SUPPLIERPAYMENT}]                                     ✓ picked D/396, ignored E/468

invoice=9198 extracted=C/296
  → [{Number:296, Series:C, ReferenceType:SUPPLIERINVOICE},
     {Number:355, Series:D, ReferenceType:SUPPLIERPAYMENT}]                                     ✓ picked C/296, ignored D/355

invoice=3251 extracted=D/228
  → [{Number:228, Series:D, ReferenceType:SUPPLIERINVOICE},
     {Number:278, Series:E, ReferenceType:SUPPLIERPAYMENT}]                                     ✓ picked D/228, ignored E/278
```

If the filter had been broken, rows 3-5 would show the payment voucher numbers instead. They don't — load-bearing detail confirmed in real data.

### Phase D impact: zero

The `(voucher_series, voucher_number)` columns are written but no live read path consumes them. Only `sql/p20-voucher-rebate-backfill-APPLY.sql` ever joined on them, and that's a one-time SQL operation that already ran via JSONB-parsing. Going forward, future P2.0-style operations can join on the columns directly (faster) or via JSONB (still works) — same result either way.

The Phase D needs_review queue is unchanged by this ticket.

## Ticket 2 — what was characterised, what was parked

### Cache coverage today

- **Chicce**: 2,649 voucher headers, years 2025 + 2026, series A/B/C/D/E/F/FT/G/H/M
- **Vero**: 1,609 voucher headers, **year 2026 only**, series A/B/C/D — no 2025 vouchers cached

### Rescue ceiling (lines that would gain a ground-truth account after re-warm)

For each business, lines with `account_number IS NULL` were classified:

| Class | Chicce | Vero |
|---|---:|---:|
| Total NULL-account lines | 8,387 | 1,141 |
| → cache-hit, multi-account (Op 1 left NULL deliberately) | 5,653 | 285 |
| → **cache-miss, recoverable by re-warm** | **1,860** | **494** |
| → no JSONB Vouchers (genuinely unrecoverable) | 874 | 362 |
| Re-warm rescue ceiling | 22.2% | 43.3% |

**Why Ticket 2 is parked**

At Vero's queue scale (2,182 needs_review lines post-Fix-2), backfilling 494 lines mid-watch could shift the queue by ~20%+ in the exact signal Phase D is built to read. The 2026-06-07 decision (P2.0 validated vs reprioritise to Phase 3) depends on a stable Vero queue-drain measurement. Adding a 494-line back-fill during the watch would force "owner drainage" and "Ticket 2 rescue" to compete for the same metric — even with precise timestamp tagging, the read becomes muddied. The whole point of doing the Gate-0 cleanups ahead of the watch was a stable baseline; Ticket 2 belongs behind the watch for the same reason, not in front of it.

### Open question for Ticket 2's revisit (after 2026-06-07)

Chicce's 8,387 NULL-account lines is much larger than the ~901 Op 1 backfilled in the original P2.0. The current best hypothesis is benign:
- Most Chicce supplier lines carry `account_source='fortnox_row'` already (Fortnox posts AccountNumber at receipt time), so they're not in the NULL set at all
- The 8,387 is dominated by the 5,653 multi-account lines Op 1 deliberately left alone (single-expense-account-only rule)
- Plus 874 lines with no Vouchers in JSONB (PDF-extracted? orphaned?)

That's a hypothesis, not a confirmed split. **When Ticket 2 is revisited after 2026-06-07, the first step is to confirm this split cleanly** — `account_source` distribution across the 8,387 + count of multi-account vs orphan invoices. That decides whether the multi-account 5,653 is a long-tail worth tackling with a dominant-by-amount heuristic, or whether it's the right conservative default at scale.

### Ticket 2 scope estimate (for whoever picks it up after 2026-06-07)

- **Pull Vero 2025 vouchers via the existing `/vouchers` voucher-sync path** — rate-limit-aware (2 in-flight per token per the Fortnox semaphore already in `fortnoxFetch`), paginate, run off-peak so it doesn't collide with the daily master-sync window (05:00 UTC). Series A/B/C/D, year 2025. Volume estimate: similar to 2026's 1,609 = roughly 1,500 voucher headers, ~3,500 voucher rows.
- **Pull Chicce older periods** — series A-M, years pre-2025. Need to characterise specifically which series×year combos are missing for the 1,860 cache-miss lines (the year info isn't on the supplier-invoice voucher refs directly; would need a separate Fortnox call to discover the gaps).
- **Re-run the P2.0 Op 1 back-fill** scoped to just the newly-joinable lines (single-expense-account invoices only). Reuse the atomic correction pattern from P2.0 in case any alias-clears result.
- **Tag the Phase D queue effect precisely** — record exact timestamp + per-business line count of needs_review state changes so the next 7-day window can subtract them from owner-drain signal.

## Confirmation: cost path and existing P2.0 back-fill values UNCHANGED

- Ticket 1 only writes to `fortnox_supplier_invoices.voucher_series` + `voucher_number` columns. No touches to `supplier_invoice_lines.account_number`, `tracker_data`, `tracker_line_items`, or any cost surface.
- The P2.0 voucher back-fill values (`account_number` set with `account_source='voucher_backfill'` on ~7,952 lines) are untouched — no re-derivation, no recomputation.
- No matched-with-alias state changes. No rematch triggered.
