-- backfill-vero-april-vat-misrouting.sql
--
-- One-off corrective backfill for the VAT misrouting bug confirmed in
-- docs/investigation/vat-misrouting-verdict.md. NOT a numbered migration
-- (M___) because it doesn't change schema or define a re-runnable rollup
-- pattern — it's a single-business, single-period data fix.
--
-- WHAT THIS DOES
-- --------------
-- Moves 48,468 SEK out of Vero Italiano's April 2026 takeaway_revenue
-- bucket. The 48,468 SEK is the entire amount that was attributed to
-- Fortnox account 3053 "Försäljning varor 6% moms Sv" by the now-fixed
-- classifyByVat regex. After this backfill:
--
--   Before: takeaway_revenue = 137,301 (= 88,833 Wolt/3072 + 48,468 mis-bucketed)
--   After:  takeaway_revenue =  88,833 (= 88,833 Wolt/3072 only, correct)
--
-- The 48,468 SEK does NOT move into dine_in_revenue or alcohol_revenue.
-- It stays in `revenue` (total revenue is unaffected) but is now
-- unclassified — consistent with the Phase 1 plan §3.1 Option γ. A
-- follow-up admin UI (Phase 2) will let the owner explicitly map
-- account 3053 to dine_in or takeaway as they choose.
--
-- INVARIANTS
-- ----------
-- - Pinned to business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' (Vero Italiano)
-- - Pinned to (period_year, period_month) = (2026, 4)
-- - Pinned to fortnox_account = 3053
-- - Idempotent: re-running is a no-op (the WHERE clause matches nothing
--   after the first successful run)
-- - Wrapped in a transaction; the verification SELECT prints the final
--   state. If it doesn't match the expected values, ROLLBACK instead of COMMIT.
--
-- HOW TO APPLY
-- ------------
-- 1. Open Supabase SQL Editor (dashboard → SQL → New query)
-- 2. Paste the WHOLE file (including the verification SELECT at the end)
-- 3. Run it
-- 4. Inspect the verification output:
--    - line_items_after should show 0 rows for fortnox_account=3053 with subcategory='takeaway'
--    - tracker_data_after should show takeaway_revenue=88833 for Vero April 2026
-- 5. If the verification matches, the implicit COMMIT at end-of-statement
--    has already persisted. If anything looks off, run the ROLLBACK block
--    below WITHIN the same session before any other query.
--
-- ROLLBACK (run if verification fails)
-- ------------------------------------
-- Pre-state for reference (from diagnostic 2026-05-30):
--   tracker_line_items: 1 row at fortnox_account=3053, subcategory='takeaway',
--     amount=48468 (Vero, 2026-04, label_sv='Försäljning varor 6% moms Sv')
--   tracker_data:      takeaway_revenue=137301 for Vero 2026-04
-- To restore:
--   UPDATE tracker_line_items
--      SET subcategory = 'takeaway'
--    WHERE business_id    = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
--      AND period_year    = 2026
--      AND period_month   = 4
--      AND fortnox_account = 3053;
--   UPDATE tracker_data
--      SET takeaway_revenue = 137301
--    WHERE business_id    = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
--      AND period_year    = 2026
--      AND period_month   = 4;

BEGIN;

-- ── 1. Re-tag the line item subcategory to NULL ─────────────────────────
UPDATE tracker_line_items
   SET subcategory = NULL
 WHERE business_id    = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'  -- Vero Italiano
   AND period_year    = 2026
   AND period_month   = 4
   AND category       = 'revenue'
   AND fortnox_account = 3053
   AND subcategory    = 'takeaway';     -- idempotent: skip if already null

-- ── 2. Re-derive tracker_data.takeaway_revenue from corrected line items ─
-- Sums the still-takeaway-tagged revenue lines for this (business, period).
-- After step 1 this excludes the 3053 row, so the new value should equal
-- the Wolt/Foodora line(s) only — 88,833 SEK.
UPDATE tracker_data td
   SET takeaway_revenue = (
     SELECT COALESCE(SUM(tli.amount), 0)
       FROM tracker_line_items tli
      WHERE tli.business_id  = td.business_id
        AND tli.period_year  = td.period_year
        AND tli.period_month = td.period_month
        AND tli.category     = 'revenue'
        AND tli.subcategory  = 'takeaway'
   )
 WHERE td.business_id  = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND td.period_year  = 2026
   AND td.period_month = 4;

-- ── 3. Verification ─────────────────────────────────────────────────────

-- Should return 0 rows after the UPDATE:
SELECT 'line_items_still_misrouted' AS check_name,
       fortnox_account, label_sv, subcategory, amount
  FROM tracker_line_items
 WHERE business_id    = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND period_year    = 2026
   AND period_month   = 4
   AND fortnox_account = 3053
   AND subcategory    = 'takeaway';

-- Should show subcategory=NULL now for the 3053 line:
SELECT 'line_items_3053_after' AS check_name,
       fortnox_account, label_sv, subcategory, amount
  FROM tracker_line_items
 WHERE business_id    = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND period_year    = 2026
   AND period_month   = 4
   AND fortnox_account = 3053;

-- Should show takeaway_revenue=88833 for Vero April 2026:
SELECT 'tracker_data_after' AS check_name,
       period_year, period_month, revenue,
       dine_in_revenue, takeaway_revenue, alcohol_revenue,
       (revenue - dine_in_revenue - takeaway_revenue - alcohol_revenue) AS unclassified_residual
  FROM tracker_data
 WHERE business_id    = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND period_year    = 2026
   AND period_month   = 4;

-- Sanity: all other Vero months should be unchanged. Should match the
-- diagnostic verdict's B.1 snapshot for Jan-Mar 2026.
SELECT 'tracker_data_other_months' AS check_name,
       period_year, period_month, revenue,
       dine_in_revenue, takeaway_revenue, alcohol_revenue
  FROM tracker_data
 WHERE business_id  = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND period_year  = 2026
   AND period_month IN (1, 2, 3)
 ORDER BY period_month;

COMMIT;
