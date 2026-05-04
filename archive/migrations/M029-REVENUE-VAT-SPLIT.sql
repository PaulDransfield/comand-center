-- M029-REVENUE-VAT-SPLIT.sql
-- ============================================================================
-- Promotes the Swedish VAT-rate revenue split to first-class columns on
-- tracker_data, matching the existing revenue_logs columns from the POS side.
-- See FIXES.md §0o.
--
-- The three Swedish restaurant VAT rates encode product/service classification:
--   25 %  → alcohol & non-food drinks       → alcohol_revenue
--   12 %  → dine-in food                     → dine_in_revenue
--    6 %  → takeaway food (Wolt/Foodora etc) → takeaway_revenue
--
-- All three are SUBSETS of `revenue` (never additive). Owners need the
-- takeaway slice broken out specifically because platform delivery (Wolt /
-- Foodora) carries ~30 % commission — 100 k of takeaway ≠ 100 k of margin
-- contribution. Pre-M029 the Performance page lumped takeaway with food.
--
-- Three concerns, one migration:
--   (A) Add the three columns.
--   (B) Re-tag existing tracker_line_items so 6 %-VAT rows carry
--       subcategory='takeaway' (was 'food') and 25 %-VAT rows that didn't
--       get tagged carry subcategory='alcohol'. Idempotent.
--   (C) Backfill (A) from re-tagged line items per (business, year, month).
-- ============================================================================

BEGIN;

-- ── (A) Three new tracker_data columns ───────────────────────────────────────
ALTER TABLE tracker_data
  ADD COLUMN IF NOT EXISTS dine_in_revenue   NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS takeaway_revenue  NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alcohol_revenue   NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── (B) Re-tag existing line items ───────────────────────────────────────────
-- 6 %-VAT revenue rows previously got subcategory='food' from classifyByVat
-- (which lumped 12 % and 6 % together). Move them to 'takeaway' so the
-- Performance page revenue split bucket them correctly going forward.
--
-- Pattern matches "6% moms", "6 % moms", "moms 6", "6%moms", etc.
UPDATE tracker_line_items
   SET subcategory = 'takeaway'
 WHERE category = 'revenue'
   AND (
         label_sv ~* '\m6\s*%\s*moms\M'
      OR label_sv ~* '\mmoms\s*6\s*%\M'
      OR label_sv ~* '\mwolt\M'
      OR label_sv ~* '\mfoodora\M'
      OR label_sv ~* '\muber\s*eats\M'
       )
   AND subcategory IS DISTINCT FROM 'takeaway';

-- 25 %-VAT revenue rows where the existing subcategory didn't catch it.
UPDATE tracker_line_items
   SET subcategory = 'alcohol'
 WHERE category = 'revenue'
   AND label_sv ~* '\m25\s*%\s*moms\M'
   AND (subcategory IS NULL OR subcategory NOT IN ('alcohol','beverage','beverages','drinks'));

-- 12 %-VAT revenue rows that may have ended up with a stale subcategory.
-- Only fix when current value is null OR was the legacy generic 'food'.
-- Don't disturb anything more specific.
UPDATE tracker_line_items
   SET subcategory = 'food'
 WHERE category = 'revenue'
   AND label_sv ~* '\m12\s*%\s*moms\M'
   AND (subcategory IS NULL OR subcategory = 'food' OR subcategory = '');

-- ── (C) Backfill new tracker_data columns from re-tagged line items ─────────
-- One pass per VAT bucket. Each bucket sums the matching line-item amounts
-- per (business, year, month) and writes into the corresponding column. Only
-- writes when the current column value is 0, so manual entries (if any
-- accountant ever sets one of these directly) aren't overwritten.

-- Dine-in (12 % moms)
WITH src AS (
  SELECT business_id, period_year, period_month, SUM(amount)::numeric(12,2) AS total
    FROM tracker_line_items
   WHERE category = 'revenue'
     AND subcategory = 'food'
   GROUP BY business_id, period_year, period_month
)
UPDATE tracker_data td
   SET dine_in_revenue = src.total
  FROM src
 WHERE td.business_id     = src.business_id
   AND td.period_year     = src.period_year
   AND td.period_month    = src.period_month
   AND td.dine_in_revenue = 0;

-- Takeaway (6 % moms — Wolt / Foodora etc)
WITH src AS (
  SELECT business_id, period_year, period_month, SUM(amount)::numeric(12,2) AS total
    FROM tracker_line_items
   WHERE category = 'revenue'
     AND subcategory = 'takeaway'
   GROUP BY business_id, period_year, period_month
)
UPDATE tracker_data td
   SET takeaway_revenue = src.total
  FROM src
 WHERE td.business_id      = src.business_id
   AND td.period_year      = src.period_year
   AND td.period_month     = src.period_month
   AND td.takeaway_revenue = 0;

-- Alcohol (25 % moms)
WITH src AS (
  SELECT business_id, period_year, period_month, SUM(amount)::numeric(12,2) AS total
    FROM tracker_line_items
   WHERE category = 'revenue'
     AND subcategory IN ('alcohol','beverage','beverages','drinks')
   GROUP BY business_id, period_year, period_month
)
UPDATE tracker_data td
   SET alcohol_revenue = src.total
  FROM src
 WHERE td.business_id     = src.business_id
   AND td.period_year     = src.period_year
   AND td.period_month    = src.period_month
   AND td.alcohol_revenue = 0;

-- Defensive clamp: each subset cannot exceed total revenue (rounding can
-- push a backfilled subset 1-2 SEK above when line items are 1:1 with
-- rollup). Cap at revenue so the Performance page math doesn't ever show
-- "subset > total".
UPDATE tracker_data
   SET dine_in_revenue  = LEAST(dine_in_revenue,  revenue),
       takeaway_revenue = LEAST(takeaway_revenue, revenue),
       alcohol_revenue  = LEAST(alcohol_revenue,  revenue)
 WHERE source = 'fortnox_pdf'
   AND (dine_in_revenue > revenue OR takeaway_revenue > revenue OR alcohol_revenue > revenue);

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT
  COUNT(*)                                       AS total_fortnox_rows,
  COUNT(*) FILTER (WHERE dine_in_revenue  <> 0)  AS rows_with_dine_in,
  COUNT(*) FILTER (WHERE takeaway_revenue <> 0)  AS rows_with_takeaway,
  COUNT(*) FILTER (WHERE alcohol_revenue  <> 0)  AS rows_with_alcohol_rev
 FROM tracker_data
WHERE source = 'fortnox_pdf';

SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'tracker_data'
   AND column_name IN ('dine_in_revenue','takeaway_revenue','alcohol_revenue')
 ORDER BY column_name;

-- Subcategory distribution after re-tagging (sanity check)
SELECT subcategory, COUNT(*) AS line_items, ROUND(SUM(amount))::int AS total_kr
  FROM tracker_line_items
 WHERE category = 'revenue'
 GROUP BY subcategory
 ORDER BY line_items DESC;

COMMIT;
