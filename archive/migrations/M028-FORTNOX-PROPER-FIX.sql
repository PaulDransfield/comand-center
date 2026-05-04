-- M028-FORTNOX-PROPER-FIX.sql
-- ============================================================================
-- Fortnox extraction pipeline — Tier 2 architectural fix (FIXES.md §0n).
--
-- Three concerns, one migration:
--   (A) Add the columns the extraction has been silently dropping —
--       depreciation, financial, alcohol_cost on tracker_data.
--   (B) Add supersede semantics on fortnox_uploads so re-uploading a
--       corrected PDF properly retires the prior extraction with a
--       traceable link instead of leaving orphan applied rows.
--   (C) Backfill (A) for already-applied uploads so historical Performance
--       page numbers become correct without forcing re-uploads.
--
-- All operations are idempotent (IF NOT EXISTS / DROP IF EXISTS) and
-- non-destructive — no existing data is modified beyond the backfill.
-- ============================================================================

BEGIN;

-- ── (A) tracker_data: depreciation + financial + alcohol_cost ────────────────
-- depreciation: 78xx accounts (avskrivningar). Always a cost — stored positive.
-- financial:    8xxx accounts (interest expense + interest income). SIGNED:
--               negative for net interest expense, positive for net interest
--               income. Convention matches extract-worker + apply (see
--               lib/finance/conventions.ts).
-- alcohol_cost: subset of food_cost — 25%-VAT goods (drinks/alcohol). Derived
--               from line items by VAT classifier. Promoted to first-class
--               column so the Performance page can read the food/alcohol split
--               from the rollup directly instead of summing line items.

ALTER TABLE tracker_data
  ADD COLUMN IF NOT EXISTS depreciation NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS financial    NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alcohol_cost NUMERIC(12,2) NOT NULL DEFAULT 0;

-- ── (B) fortnox_uploads: supersede chain ─────────────────────────────────────
-- supersedes_id      → points BACK at the upload this one replaced
-- superseded_by_id   → points FORWARD at the upload that replaced this one
-- Either is null for "current" uploads. When apply() finds a prior applied
-- upload for the same (business, year, month), it sets the OLD row's status
-- to 'superseded' and links both directions.

ALTER TABLE fortnox_uploads
  ADD COLUMN IF NOT EXISTS supersedes_id    UUID REFERENCES fortnox_uploads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_id UUID REFERENCES fortnox_uploads(id) ON DELETE SET NULL;

-- Status check needs 'superseded' as a valid terminal state. Drop + recreate
-- since we don't know the exact existing constraint name across environments.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'fortnox_uploads'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE fortnox_uploads DROP CONSTRAINT %I', cname);
  END IF;
END$$;

ALTER TABLE fortnox_uploads
  ADD CONSTRAINT fortnox_uploads_status_check
  CHECK (status IN ('pending','extracting','extracted','applied','failed','rejected','superseded'));

-- Index for the "find prior applied upload for this period" lookup that
-- apply() does on every run. (business_id, period_year, period_month, status)
-- with a partial index on applied is the hot path.
CREATE INDEX IF NOT EXISTS idx_fortnox_uploads_active_period
  ON fortnox_uploads (business_id, period_year, period_month)
  WHERE status = 'applied';

-- ── (C) Backfill — extract from already-applied extracted_json blobs ─────────
-- For single-month uploads: extracted_json.rollup.{depreciation,financial}
-- For multi-month uploads:  extracted_json.periods[i].rollup.* per-period
--
-- alcohol_cost is harder to backfill from extracted_json (we didn't ask Claude
-- for it as a top-level field before this migration). Best signal we have is
-- tracker_line_items where category='food_cost' AND subcategory IN
-- ('alcohol','beverages','beverage'). Sum those per (business, year, month).

-- (C.1) Single-month rollup backfill — depreciation + financial
UPDATE tracker_data td
   SET depreciation = COALESCE((fu.extracted_json->'rollup'->>'depreciation')::numeric, 0),
       financial    = COALESCE((fu.extracted_json->'rollup'->>'financial')::numeric, 0)
  FROM fortnox_uploads fu
 WHERE td.fortnox_upload_id = fu.id
   AND fu.status            = 'applied'
   AND fu.doc_type          = 'pnl_monthly'
   AND td.depreciation      = 0   -- only fill blanks; never overwrite manual entries
   AND td.financial         = 0;

-- (C.2) Multi-month rollup backfill — pull per-period from periods[] array
WITH multi AS (
  SELECT
    fu.id            AS upload_id,
    fu.business_id,
    (period->>'year')::int    AS period_year,
    (period->>'month')::int   AS period_month,
    COALESCE((period->'rollup'->>'depreciation')::numeric, 0) AS depreciation,
    COALESCE((period->'rollup'->>'financial')::numeric,    0) AS financial
   FROM fortnox_uploads fu
        CROSS JOIN LATERAL jsonb_array_elements(fu.extracted_json->'periods') AS period
  WHERE fu.status   = 'applied'
    AND fu.doc_type = 'pnl_multi_month'
    AND jsonb_typeof(fu.extracted_json->'periods') = 'array'
)
UPDATE tracker_data td
   SET depreciation = m.depreciation,
       financial    = m.financial
  FROM multi m
 WHERE td.business_id   = m.business_id
   AND td.period_year   = m.period_year
   AND td.period_month  = m.period_month
   AND td.depreciation  = 0
   AND td.financial     = 0;

-- (C.3) alcohol_cost backfill from line items
WITH alcohol AS (
  SELECT
    business_id,
    period_year,
    period_month,
    SUM(amount)::numeric(12,2) AS total
   FROM tracker_line_items
  WHERE category = 'food_cost'
    AND subcategory IN ('alcohol','beverages','beverage')
  GROUP BY business_id, period_year, period_month
)
UPDATE tracker_data td
   SET alcohol_cost = a.total
  FROM alcohol a
 WHERE td.business_id  = a.business_id
   AND td.period_year  = a.period_year
   AND td.period_month = a.period_month
   AND td.alcohol_cost = 0;

-- (C.4) Recompute net_profit for backfilled rows so the persisted value
-- matches the new convention (revenue − food − staff − other − depreciation
-- + financial). Margin_pct follows. Only touches rows where we just wrote
-- a non-zero depreciation or financial — manual entries stay alone.
UPDATE tracker_data
   SET net_profit = ROUND(revenue - food_cost - staff_cost - other_cost - depreciation + financial),
       margin_pct = CASE
                      WHEN revenue > 0
                        THEN ROUND(((revenue - food_cost - staff_cost - other_cost - depreciation + financial) / revenue) * 1000) / 10
                      ELSE 0
                    END
 WHERE source = 'fortnox_pdf'
   AND (depreciation <> 0 OR financial <> 0);

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT
  COUNT(*)                                         AS total_fortnox_rows,
  COUNT(*) FILTER (WHERE depreciation <> 0)        AS rows_with_depreciation,
  COUNT(*) FILTER (WHERE financial    <> 0)        AS rows_with_financial,
  COUNT(*) FILTER (WHERE alcohol_cost <> 0)        AS rows_with_alcohol
 FROM tracker_data
WHERE source = 'fortnox_pdf';

SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'tracker_data'
   AND column_name IN ('depreciation','financial','alcohol_cost')
 ORDER BY column_name;

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'fortnox_uploads'
   AND column_name IN ('supersedes_id','superseded_by_id')
 ORDER BY column_name;

COMMIT;
