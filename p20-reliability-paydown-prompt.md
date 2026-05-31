# Claude Code — P2.0 Reliability Paydown: Voucher Columns + Cache Re-warm

## Purpose

Two companion tickets surfaced during P2.0, both pure reliability, both compounding with the voucher back-fill already shipped — and both improving the Phase D read while it's in flight (a fuller voucher cache = a cleaner ground-truth signal on the lines we're measuring). Neither depends on the Phase D outcome.

1. **JSONB → columns:** the supplier-sync cron leaves `voucher_series` + `voucher_number` inside `raw_data.Vouchers` JSONB, so the back-fill join parses JSONB at read time. Extract them into dedicated columns so the join is column-level and future code doesn't re-parse JSONB.
2. **Cache re-warm:** the voucher cache (`fortnox_vouchers_cache`, M080) only covers recent periods, capping the back-fill join match rate at ~71% (Chicce) / ~78% (Vero). Re-warm older periods to lift coverage — more lines get their ground-truth account.

Code + data change touching a Fortnox-fed cache. Investigation-first, dry-run before any write, idempotent, feature branch + preview, **no prod deploy without review.** Respect Fortnox rate limits on the re-warm.

## HARD RULES

- **Dry-run / characterise before any write.** Show what would change before changing it.
- **Idempotent.** Re-running the column backfill is a no-op; the cache re-warm uses the existing SELECT-then-INSERT/upsert idempotency, never duplicates voucher rows.
- **Do not touch the cost path** or any P2.0 classification logic — this is plumbing only. Account back-fill values must be unchanged where the join already succeeded.
- **Respect Fortnox throttle** on the re-warm — paginate, back off, run off-peak so it doesn't collide with the live daily sync's quota. Sample/scope the periods; don't pull everything blindly.
- Feature branch; same-commit DB+TS for any new column/CHECK; RLS holds; model strings (if any AI touched, unlikely here) from `lib/ai/models.ts`.

## Ticket 1 — Extract voucher_series + voucher_number into columns

### Step 0 — characterise (READ-ONLY)
- Confirm where the values live today in `fortnox_vouchers_cache.raw_data` (the `Vouchers` JSONB shape — `VoucherSeries` / `VoucherNumber` keys?).
- How many cached rows have these present vs missing in the JSONB? (Determines backfill coverage.)
- Confirm the current back-fill join in `voucher-to-aggregator.ts` / the P2.0 SQL parses JSONB at read time, and exactly which expression — so the new columns replace it like-for-like.

### Step 1 — schema + backfill (dry-run → reviewed → write)
- M-migration (additive): `fortnox_vouchers_cache.voucher_series TEXT`, `voucher_number TEXT` (nullable). Index the pair if the join uses it.
- Backfill the columns from existing `raw_data` JSONB for all rows where present. Idempotent (only sets where currently NULL; re-run is a no-op).
- Update the **sync cron** to populate the columns on every future write (so this doesn't re-rot).
- Repoint the back-fill join (and any other JSONB-parsing read site) to the columns. Confirm the join result is **identical** to the JSONB-parse version on a sample before/after — same matched line count, same accounts.

## Ticket 2 — Re-warm the voucher cache for older periods

### Step 0 — characterise (READ-ONLY)
- Per business (Chicce, Vero), what period range does `fortnox_vouchers_cache` currently cover, and where are the gaps that cause the ~71% / ~78% unmatched back-fill lines?
- Quantify: of the supplier-invoice lines that currently FAIL the voucher join, how many fall in a period the cache simply doesn't cover (re-warm would fix) vs genuinely have no matching voucher (re-warm won't help)? This sets the realistic ceiling — don't promise 100%.

### Step 1 — re-warm (scoped, rate-limited)
- Pull the missing-period vouchers via the existing Fortnox voucher-sync path (reuse it; don't write a new fetch). Scope to the gap periods identified in Step 0, not a blind full pull.
- Idempotent upsert into the cache — no duplicate voucher rows.
- Rate-limit-aware (paginate + back off), off-peak.

### Step 2 — re-run the back-fill join over newly-covered lines (dry-run → reviewed)
- With the cache fuller, how many previously-unmatched lines now get a ground-truth account? Dry-run the account back-fill over just those newly-joinable lines.
- **Apply only after review**, through the same P2.0 path (single-account clean; multi-account left NULL; provenance `account_source='voucher_backfill'`; idempotent). Reuse the P2.0 atomic correction pattern if any alias-clears result.
- Report the new match rate per business (was 71% / 78% → now ?).

## Deliverable

`docs/investigation/p20-reliability-paydown.md` + chat summary:
- Ticket 1: column backfill coverage, join repointed, before/after join identical confirmation.
- Ticket 2: period gaps found, lines recoverable by re-warm vs genuinely unmatchable, new match rate per business, lines newly back-filled.
- Confirmation the cost path and existing back-fill values are unchanged.
- Note any effect on the Phase D queue (newly back-filled lines may shift a few needs_review states — report so it's not a surprise mid-watch).

## One watch-out

This runs **during the Phase D watch.** If Ticket 2 back-fills more lines, it can change the `needs_review` queue depth mid-measurement. That's fine — but **record exactly what moved and when**, so the Phase D queue-drain signal isn't misread as owner activity when it was actually this paydown. Tag the change clearly in the report and flag it for the 2026-06-07 read.
