# Voucher backfill plan — close the BAS-account gap

> Status: PLAN ONLY (not implemented). Written 2026-05-24 to scope a
> session before we commit to it. Revisit when the gap actually hurts —
> right now the supplier-name classifier covers ~90% of Chicce's needs
> after the bulk-review queue + skip-supplier features landed.

## The problem

`supplier_invoice_lines.account_number` is populated 0% of the time
for Chicce (verified via `scripts/diag-chicce-account-numbers.mjs`,
2026-05-23). The matcher's gate-0 BAS-account routing
(`lib/inventory/categories.ts`) is therefore inactive for them and we
fall back to the supplier-name classifier, which:

- correctly tags E.ON / Fortnox / PreZero / Securitas / Fora / accountants
  / etc. as `not_inventory` ✓
- misses business-specific overheads (ÖREBRO-TVÄTT, Tingstad Papper)
  → land in `needs_review` requiring manual triage
- can't sub-categorise food vs beverage vs alcohol the way BAS codes do
  (4010 = food, 4022 = beverage, 4025 = alcohol)

Why account_number is null: Fortnox's `SupplierInvoiceRow.AccountNumber`
is only populated after the invoice is **bokförd** (posted to ledger).
Chicce's bookkeeper either books in bulk monthly or uses an import flow
that doesn't post per-row codes back to the supplier-invoice rows.

The accounts ARE on the **voucher** (verifikation) — the journal entry
created when the invoice is booked. Voucher rows always carry
`AccountNumber`. So the data exists; we just need to fetch it from a
different endpoint and join back.

## The endpoints

Fortnox API surfaces relevant here:

- `GET /3/supplierinvoices/{givenNumber}` → returns the invoice with a
  `VoucherSeries` + `VoucherNumber` reference (or `Booked: true/false`
  flag).
- `GET /3/vouchers/{series}/{voucherNumber}` → returns the voucher with
  its `VoucherRows[]`, each having `Account`, `Debit`/`Credit`,
  optional `TransactionInformation` (often the supplier+description).

Series for supplier invoices is conventionally `A` (verifikationsserie
A) but configurable per business. Read it from the supplier invoice
itself, don't hardcode.

## Matching voucher rows back to invoice rows

This is the hard part. There's no foreign key — the voucher is a free-
form journal entry that the bookkeeper composes. Typical pattern for
supplier invoices:

```
Voucher V-A-1234 for invoice 9876:
  Debit  4010 (Råvaror)              1000.00   "Kött"      → matches invoice row 1
  Debit  4020 (Frukt och grönt)       350.00   "Tomater"   → matches invoice row 2
  Debit  2641 (Ingående moms 25%)     337.50   (VAT)
  Credit 2440 (Leverantörsskulder)   1687.50   (total)
```

Matching strategy:

1. **Filter out non-account rows**: VAT (2640-2649), accounts payable
   (2440), bank/cash (1930-1940), discounts. Keep only 4xxx (CoGS),
   5xxx (premises if allowlisted), maybe 6xxx for sub-categorising
   non-inventory.
2. **Match invoice row → voucher row by amount, then by description
   trigram similarity** as fallback.
3. **Edge cases**:
   - One voucher row covers multiple invoice rows (bookkeeper grouped
     them by account). Split the AccountNumber proportionally — every
     invoice row in the group gets the same code.
   - Voucher rows don't sum to invoice total (rounding, manual
     corrections). Match what we can; flag the rest for owner.
   - Multiple invoices share one voucher (rare but happens).

Recommended MVP: amount-match first, give up on tied rows. Don't try
to be too clever; better to leave 5% unaccounted than to mis-categorise
1% silently. Surface unmatched-row count for review.

## Implementation sketch

### Schema additions

```sql
-- M0xx — voucher backfill state
ALTER TABLE supplier_invoice_lines
  ADD COLUMN IF NOT EXISTS account_source TEXT
    CHECK (account_source IS NULL OR account_source IN ('invoice_row', 'voucher_backfill'));

CREATE TABLE IF NOT EXISTS voucher_backfill_state (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  last_run_at TIMESTAMPTZ,
  rows_updated INT DEFAULT 0,
  rows_unmatched INT DEFAULT 0
);
```

### Pipeline

1. **`/api/cron/voucher-backfill-business`** (admin/cron-secret auth, body `{ business_id }`):
   - Find every `supplier_invoice_lines` row where `account_number IS NULL`
     for this business.
   - Group by `fortnox_invoice_number`.
   - For each invoice:
     - GET `/3/supplierinvoices/{number}` → check Booked + read VoucherSeries / VoucherNumber.
     - If not booked, skip (re-try later).
     - GET `/3/vouchers/{series}/{voucherNumber}` → extract VoucherRows[].
     - Filter VoucherRows to 4xxx / 5xxx accounts.
     - Match VoucherRows ↔ invoice rows by amount; if unique, apply
       AccountNumber to the matched line.
   - Update `voucher_backfill_state` with counts.

2. **Schedule**: weekly or on-demand. Don't run hourly — vouchers don't
   change that often, and Fortnox rate-limits.

3. **Re-trigger the matcher** for any lines that just got an
   `account_number`: their match_status may flip from `needs_review`
   to a proper category match. Either run the existing rematcher
   immediately, or let the periodic chain pick them up.

### Auth / scopes

Fortnox `bookkeeping` scope required for `/vouchers`. Verify the
business's connected integration has it before kicking the backfill —
otherwise the calls 401.

## Risks

- **API rate limits**: Fortnox is ~3 req/s per integration. 762 invoices
  → ~5 minutes of throttled fetching. Use `withTimeout` + queue with
  delay; don't burst.
- **Misclassification**: amount-match collisions where two invoice rows
  have the same total. Defensive: when ambiguous, leave account_number
  NULL + log to a `voucher_match_failures` table for review.
- **Bookkeeper hasn't booked yet**: invoices come in faster than they're
  booked. Skipped invoices stay in `needs_review` indefinitely. Should
  cron alert on stale unbooked-invoice counts.
- **Pre-Fortnox era**: businesses that switched to Fortnox mid-history
  won't have vouchers for earlier invoices. Backfill is best-effort
  from the Fortnox cutover date forward.

## Why we're parking this

The user-impact case is weakest right now:
- Supplier-name classifier + skip-supplier UI handles ~90% of routing.
- Chicce just finished bulk-review for the first time; the catalogue
  is mostly seeded.
- Voucher backfill helps ongoing curation (future invoices land
  pre-categorised) but doesn't unlock anything blocked today.

Revisit when:
- A second customer onboards and we see the same NULL-account_number
  pattern — confirms it's systemic not Chicce-specific.
- The bulk-review queue is the bottleneck for new customer onboarding
  (we feel the manual-triage cost on a real schedule).
- Owner-feedback explicitly asks for it.

Estimated effort: ~1 day of focused work assuming the Fortnox API
surface is as documented. Add half a day for the matcher rematch loop
+ rate-limit handling + observability.
