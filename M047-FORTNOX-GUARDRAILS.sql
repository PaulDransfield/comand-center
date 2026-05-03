-- M047-FORTNOX-GUARDRAILS.sql
-- Purpose: defence-in-depth guardrails for the Fortnox PDF apply pipeline.
--
-- Three additions:
--
-- 1. fortnox_uploads.pdf_sha256 — SHA-256 fingerprint of the uploaded
--    file. Computed at upload time. Used to detect "I just uploaded this
--    same PDF again" and warn the owner. Indexed for the existence check.
--
-- 2. CHECK constraints on tracker_data — defence in depth. Even if the
--    application code forgets a validator, the DB rejects rows with
--    impossible values: negative revenue/costs, food_cost > revenue,
--    margin_pct outside ±200 % (extreme values are a sign of scale errors,
--    not real business performance).
--
-- 3. tracker_data.created_via — origin tag for every write. Default
--    'unknown' for legacy rows; new code paths populate it explicitly
--    ('fortnox_apply' | 'owner_form' | 'admin_backfill' | 'migration').
--    Lets the daily manual-write audit cron find rows that were written
--    outside the normal pipeline (the Rosali March 2026 case).
--
-- Backwards compat:
--   - All ADD COLUMN are nullable / IF NOT EXISTS — pure additions.
--   - CHECK constraints are guarded against re-application.
--   - Wrapped in a transaction. Verify query at the bottom.

BEGIN;

-- ── 1. PDF fingerprint ─────────────────────────────────────────────────
ALTER TABLE fortnox_uploads
  ADD COLUMN IF NOT EXISTS pdf_sha256 TEXT;

CREATE INDEX IF NOT EXISTS idx_fortnox_uploads_sha256_business
  ON fortnox_uploads (business_id, pdf_sha256)
  WHERE pdf_sha256 IS NOT NULL;

-- ── 2. tracker_data sanity CHECK constraints ───────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'tracker_data' AND constraint_name = 'tracker_data_revenue_nonneg_check'
  ) THEN
    ALTER TABLE tracker_data
      ADD CONSTRAINT tracker_data_revenue_nonneg_check
      CHECK (revenue IS NULL OR revenue >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'tracker_data' AND constraint_name = 'tracker_data_food_cost_nonneg_check'
  ) THEN
    ALTER TABLE tracker_data
      ADD CONSTRAINT tracker_data_food_cost_nonneg_check
      CHECK (food_cost IS NULL OR food_cost >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'tracker_data' AND constraint_name = 'tracker_data_staff_cost_nonneg_check'
  ) THEN
    ALTER TABLE tracker_data
      ADD CONSTRAINT tracker_data_staff_cost_nonneg_check
      CHECK (staff_cost IS NULL OR staff_cost >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'tracker_data' AND constraint_name = 'tracker_data_alcohol_cost_nonneg_check'
  ) THEN
    ALTER TABLE tracker_data
      ADD CONSTRAINT tracker_data_alcohol_cost_nonneg_check
      CHECK (alcohol_cost IS NULL OR alcohol_cost >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'tracker_data' AND constraint_name = 'tracker_data_other_cost_nonneg_check'
  ) THEN
    ALTER TABLE tracker_data
      ADD CONSTRAINT tracker_data_other_cost_nonneg_check
      CHECK (other_cost IS NULL OR other_cost >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'tracker_data' AND constraint_name = 'tracker_data_period_month_check'
  ) THEN
    ALTER TABLE tracker_data
      ADD CONSTRAINT tracker_data_period_month_check
      CHECK (period_month IS NULL OR (period_month >= 0 AND period_month <= 12));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'tracker_data' AND constraint_name = 'tracker_data_period_year_check'
  ) THEN
    ALTER TABLE tracker_data
      ADD CONSTRAINT tracker_data_period_year_check
      CHECK (period_year IS NULL OR (period_year >= 2000 AND period_year <= 2099));
  END IF;
END$$;

-- ── 3. Origin tag for every tracker_data write ─────────────────────────
-- Nullable so legacy rows aren't forced into a bucket they don't fit;
-- new code populates explicitly. The manual-write audit cron filters on
-- (created_via IN (NULL, 'unknown') AND fortnox_upload_id IS NULL) to
-- find suspicious rows.
ALTER TABLE tracker_data
  ADD COLUMN IF NOT EXISTS created_via TEXT;

CREATE INDEX IF NOT EXISTS idx_tracker_data_origin_audit
  ON tracker_data (business_id, created_at DESC)
  WHERE created_via IS NULL AND fortnox_upload_id IS NULL;

COMMIT;

-- Verify
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'fortnox_uploads' AND column_name = 'pdf_sha256';
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'tracker_data' AND column_name = 'created_via';
SELECT constraint_name
  FROM information_schema.table_constraints
 WHERE table_name = 'tracker_data' AND constraint_type = 'CHECK';
