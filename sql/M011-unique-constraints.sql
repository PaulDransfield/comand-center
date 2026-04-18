-- M011-unique-constraints.sql
-- Makes every upsert in lib/sync/engine.ts actually idempotent.
-- Without these constraints, onConflict is a silent no-op and duplicates accumulate.
--
-- Dedupe queries MUST run before adding the constraints — otherwise the ALTER
-- TABLE fails on existing duplicate rows. Each dedupe keeps the most-recently
-- updated row and deletes older duplicates.
--
-- Recommended: run one block at a time in the Supabase SQL editor, checking
-- the "would delete" count before committing each delete.

-- ── revenue_logs ──────────────────────────────────────────────────────────────
-- Upsert key used by engine.ts: (org_id, business_id, provider, revenue_date)
-- Collapses duplicate daily totals for the same provider/business into one row.

-- 1. Audit first — see how many duplicates exist.
-- SELECT org_id, business_id, provider, revenue_date, COUNT(*) AS dupes
--   FROM public.revenue_logs
--   WHERE business_id IS NOT NULL
--   GROUP BY 1,2,3,4
--   HAVING COUNT(*) > 1
--   ORDER BY dupes DESC
--   LIMIT 50;

-- 2. Dedupe — keep newest by created_at (fallback to id).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY org_id, business_id, provider, revenue_date
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS rn
    FROM public.revenue_logs
   WHERE business_id IS NOT NULL
)
DELETE FROM public.revenue_logs WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3. Add the constraint. Note: business_id nullable rows are excluded because
--    Postgres treats NULLs as distinct in a standard UNIQUE constraint.
ALTER TABLE public.revenue_logs
  DROP CONSTRAINT IF EXISTS revenue_logs_org_biz_provider_date_unique;
CREATE UNIQUE INDEX IF NOT EXISTS revenue_logs_org_biz_provider_date_unique
  ON public.revenue_logs (org_id, business_id, provider, revenue_date)
  WHERE business_id IS NOT NULL;

-- ── covers ────────────────────────────────────────────────────────────────────
-- Upsert key used by engine.ts: (business_id, date)

-- Dedupe
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY business_id, date
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS rn
    FROM public.covers
   WHERE business_id IS NOT NULL
)
DELETE FROM public.covers WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS covers_business_date_unique
  ON public.covers (business_id, date)
  WHERE business_id IS NOT NULL;

-- ── staff_logs ────────────────────────────────────────────────────────────────
-- Upsert key used by engine.ts: pk_log_url
-- Only Personalkollen-sourced rows have a pk_log_url — they must be unique.

-- Dedupe by pk_log_url
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY pk_log_url
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS rn
    FROM public.staff_logs
   WHERE pk_log_url IS NOT NULL
)
DELETE FROM public.staff_logs WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS staff_logs_pk_log_url_unique
  ON public.staff_logs (pk_log_url)
  WHERE pk_log_url IS NOT NULL;

-- ── integrations ──────────────────────────────────────────────────────────────
-- Upsert keys vary:
--   - personalkollen: (org_id, business_id, provider)
--   - inzii:          (org_id, business_id, provider, department)
--   - fortnox:        (business_id, provider)
-- The nullable-business_id problem means we need partial indexes.

-- Dedupe identical connection rows — keep newest by updated_at.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY org_id, business_id, provider, COALESCE(department, '')
           ORDER BY COALESCE(updated_at, connected_at, created_at) DESC NULLS LAST, id DESC
         ) AS rn
    FROM public.integrations
)
DELETE FROM public.integrations WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Partial unique index — handles both nullable business_id and multi-department inzii.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_org_biz_provider_dept_unique
  ON public.integrations (org_id, business_id, provider, COALESCE(department, ''))
  WHERE business_id IS NOT NULL;

-- For legacy null-business_id rows (org-level integrations), a different partial index.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_org_null_biz_provider_unique
  ON public.integrations (org_id, provider, COALESCE(department, ''))
  WHERE business_id IS NULL;

-- ── forecasts ─────────────────────────────────────────────────────────────────
-- Upsert key: (org_id, business_id, period_year, period_month)
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY org_id, business_id, period_year, period_month
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS rn
    FROM public.forecasts
   WHERE business_id IS NOT NULL
)
DELETE FROM public.forecasts WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS forecasts_org_biz_period_unique
  ON public.forecasts (org_id, business_id, period_year, period_month)
  WHERE business_id IS NOT NULL;

-- ── tracker_data ──────────────────────────────────────────────────────────────
-- Upsert key: (business_id, period_year, period_month)
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY business_id, period_year, period_month
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS rn
    FROM public.tracker_data
   WHERE business_id IS NOT NULL
)
DELETE FROM public.tracker_data WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS tracker_data_biz_period_unique
  ON public.tracker_data (business_id, period_year, period_month)
  WHERE business_id IS NOT NULL;

COMMENT ON INDEX revenue_logs_org_biz_provider_date_unique IS
  'Matches onConflict key in lib/sync/engine.ts upserts. Without this, duplicates accumulate silently.';
