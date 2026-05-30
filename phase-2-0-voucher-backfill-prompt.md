# Claude Code — Phase 2.0: Voucher-as-Ground-Truth Back-fill

## Purpose

Activate a reliable BAS-account signal that exists in the data but is currently unused. `supplier_invoice_lines.account_number` is ~100% NULL (Chicce: 3218/3218), so any BAS-account code path is dormant. The booked vouchers in `fortnox_vouchers_cache` (M080) reliably carry `Account / Debit / Credit`. Back-fill the line-level account from the matching voucher **and wire a consumer that uses it**, with two goals:

1. **Kill the Gate-0 non-inventory noise** — rebates/fees/services (the `Avtalsrabatt` cluster the audit sampler surfaced) post to different accounts than food purchases; a reliable account lets Gate 0 route them to `not_inventory` before they reach review.
2. **Test the Vero hypothesis** — whether the extra signal lifts Vero's 46.8% needs_review agreement before the warmup gate expires 2026-06-29. Measured, not assumed.

This **mutates a live table** (`supplier_invoice_lines.account_number`). Investigation-first, dry-run before any write, idempotent, feature branch + preview, **no prod deploy without review.**

## HARD RULES

- A back-fill column with no consumer is inert — this deliverable is **back-fill + consumer activation + measurement**, not just the SQL.
- **Dry-run first.** Produce the full report of what *would* be written (per business: lines affected, account distribution) and show it before any write. Re-derive/back-fill runs through SELECT-then-INSERT-style idempotency; re-running must be a no-op.
- **Do not touch the cost path.** Article unit-cost / price-creep logic must be byte-identical after this. Account back-fill is a *categorisation* signal only.
- Exclude the AP and VAT accounts from the signal (see Step 1). Back-filling 2440 or 2641 as a "category" is a correctness bug, not a no-op.
- Feature branch; same-commit DB+TS for any new enum/CHECK value; RLS holds; model strings only from `lib/ai/models.ts`.

## Step 0 — Characterise the join before writing anything (READ-ONLY)

The voucher→line mapping is **not 1:1**. Establish the reality first:

1. **Join key:** how does a `supplier_invoice_lines` row (or its parent invoice) link to a `fortnox_vouchers_cache` voucher? (Voucher series/number, invoice reference, date+supplier+amount?) Confirm a reliable join exists and its match rate.
2. **The booking shape:** confirm a booked supplier invoice's voucher = expense debit row(s) + 2641 input-VAT debit + 2440 leverantörsskulder credit. List the accounts to **exclude** (2440, 2641, rounding/öresavrundning ~3740, any FX-diff account) so only **expense debit rows** remain as the category signal.
3. **Single vs multi expense account:** per business, how many invoices map to **one** expense account (line-level back-fill is clean and unambiguous) vs **multiple** (a voucher row can't be attributed to a specific invoice line)? Report the split. This number determines coverage.
4. **Account → category sanity:** for the distinct expense accounts that appear, do they map sensibly via the existing `categories.ts` / Gate-0 logic (food, beverage, non-food, rebate, service)? Spot any account that would misroute.

Write Step 0 as a short findings block and **stop for review** if the single-account coverage is low or the join is unreliable — that changes the plan.

## Step 1 — Back-fill (dry-run → reviewed → write)

- **Single-expense-account invoices:** set `account_number` on all of that invoice's lines to that account. Clean, unambiguous.
- **Multi-expense-account invoices:** do **not** guess line attribution. Default conservative: leave those lines NULL (they keep working on the existing name/description path) and record them as "multi-account, unattributed" in the report. (A heuristic — dominant-by-amount, or amount-matching where the voucher preserves detail — is an open decision below, not a default.)
- Tag the provenance (`account_source = 'voucher_backfill'` or equivalent) so a back-filled account is distinguishable from a future Fortnox-native one. New column/enum → DB+TS same commit.
- Idempotent: re-running re-derives identical results; already-correct rows untouched.

## Step 2 — Activate the consumer

- Confirm Gate 0 (`categoryForBasAccount` in `matcher.ts`) actually reads `account_number` and does something useful when present. If it's present-but-dormant, that's the activation; if missing, build the minimal routing.
- **Route non-inventory accounts to `not_inventory`** — rebate/discount, fee, freight, service accounts should not become products. This is the rebate-noise kill; verify against the known `Avtalsrabatt` lines.
- Optionally feed `account_number` into the ai-suggest context as an additional signal (tagged), so category-consistent suggestions improve. Keep it a *signal*, not an override — name/description still primary.

## Step 3 — Measure (decomposed, not a single number)

Before/after, on the existing accuracy snapshot + a one-off report:

- **Vero needs_review agreement:** before vs after. **Decompose the change** into (a) lines re-routed to `not_inventory` (noise removed from the denominator) vs (b) genuinely better in-category suggestions on the lines that remain. We want to know *why* it moved.
- **No regression on Chicce** — agreement and category mix stable or better; cost path unchanged.
- **Rebate noise:** count of `Avtalsrabatt`/rebate lines now correctly at `not_inventory` vs before.

## Checkpoint before P2a

- Step 0 findings reviewed; single-account coverage known.
- Dry-run reviewed before the write.
- The back-fill round-trips idempotently, the consumer routes a known rebate line to `not_inventory`, and the measurement shows Vero's movement decomposed. Same end-to-end discipline as D1–D3.

## Open decisions to flag (don't guess)

1. **Multi-account invoices** — leave NULL (conservative default), or apply a documented heuristic (dominant-by-amount)? Start conservative; revisit if coverage is poor.
2. **Where rebate/discount accounts route** — confirm the BAS accounts that represent supplier rebates/bonuses and that `not_inventory` is the right bucket (vs a future "purchase adjustment" treatment that nets against cost).
