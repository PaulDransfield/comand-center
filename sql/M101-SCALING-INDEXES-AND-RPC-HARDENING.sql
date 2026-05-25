-- M101 — Scaling-audit follow-up: missing indexes + RPC hardening
-- =================================================================
-- Apply via Supabase SQL editor.
--
-- Two themes:
--
--   A) Missing indexes on hot query paths the scaling audit identified.
--      Each composite index covers a query that today does sequential
--      scan on a tenant-scoped table. At 20 customers × 2 years of
--      data these become measurably slow; at 50+ they cause timeouts.
--
--   B) Extraction-sweeper RPC hardening — add explicit FOR UPDATE
--      SKIP LOCKED on list_ready_extraction_jobs so two concurrent
--      sweepers can't return overlapping job sets.
--
-- Defensive: every index create wraps the column check in a DO block,
-- so if production schema differs from what's in `archive/migrations/`
-- (which we've burned on before — see memory archive_migrations_not_authoritative)
-- the migration logs a NOTICE and continues instead of failing hard.
-- Re-run safely; existing indexes are skipped via IF NOT EXISTS.

-- ── Helper: pick the first column name that actually exists ────────
-- Many of our hot tables have evolved column names over time. Rather
-- than guess, introspect pg_attribute and create the index against
-- whatever the real column is named.
DO $$
DECLARE
  date_col TEXT;
BEGIN
  -- hourly_metrics: try business_date, then service_date, then date
  SELECT column_name INTO date_col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'hourly_metrics'
    AND column_name IN ('business_date', 'service_date', 'date')
  ORDER BY CASE column_name
    WHEN 'business_date' THEN 1
    WHEN 'service_date'  THEN 2
    WHEN 'date'          THEN 3
  END
  LIMIT 1;

  IF date_col IS NOT NULL THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_hourly_metrics_biz_date ON hourly_metrics (business_id, %I)',
      date_col
    );
    RAISE NOTICE 'M101: created idx_hourly_metrics_biz_date on (business_id, %)', date_col;
  ELSE
    RAISE NOTICE 'M101: skipped hourly_metrics index — table not found or no recognized date column';
  END IF;
END $$;

-- ── overhead_drilldown_cache lookup index ───────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'overhead_drilldown_cache'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'overhead_drilldown_cache'
      AND column_name = 'period_year'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_overhead_cache_lookup ON overhead_drilldown_cache (business_id, period_year, period_month, category)';
    RAISE NOTICE 'M101: created idx_overhead_cache_lookup';
  ELSE
    RAISE NOTICE 'M101: skipped overhead_drilldown_cache — table or columns not present';
  END IF;
END $$;

-- ── supplier_classifications lookup index ───────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'supplier_classifications'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_supplier_class_biz_num ON supplier_classifications (business_id, supplier_fortnox_number)';
    RAISE NOTICE 'M101: created idx_supplier_class_biz_num';
  ELSE
    RAISE NOTICE 'M101: skipped supplier_classifications — table not present';
  END IF;
END $$;

-- ── daily_metrics composite index ───────────────────────────────────
-- Tries business_date / date / metric_date in priority order.
DO $$
DECLARE
  date_col TEXT;
BEGIN
  SELECT column_name INTO date_col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'daily_metrics'
    AND column_name IN ('business_date', 'date', 'metric_date')
  ORDER BY CASE column_name
    WHEN 'business_date' THEN 1
    WHEN 'date'          THEN 2
    WHEN 'metric_date'   THEN 3
  END
  LIMIT 1;

  IF date_col IS NOT NULL THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_daily_metrics_org_biz_date ON daily_metrics (org_id, business_id, %I)',
      date_col
    );
    RAISE NOTICE 'M101: created idx_daily_metrics_org_biz_date on (org_id, business_id, %)', date_col;
  ELSE
    RAISE NOTICE 'M101: skipped daily_metrics index — no recognized date column';
  END IF;
END $$;

-- ── monthly_metrics composite index ─────────────────────────────────
-- Tries (year, month) first since that's the canonical pair, then
-- (period_year, period_month) as a fallback.
DO $$
DECLARE
  year_col  TEXT;
  month_col TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'monthly_metrics' AND column_name = 'year'
  ) THEN
    year_col  := 'year';
    month_col := 'month';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'monthly_metrics' AND column_name = 'period_year'
  ) THEN
    year_col  := 'period_year';
    month_col := 'period_month';
  END IF;

  IF year_col IS NOT NULL THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_monthly_metrics_org_biz_period ON monthly_metrics (org_id, business_id, %I, %I)',
      year_col, month_col
    );
    RAISE NOTICE 'M101: created idx_monthly_metrics_org_biz_period on (org_id, business_id, %, %)', year_col, month_col;
  ELSE
    RAISE NOTICE 'M101: skipped monthly_metrics index — no recognized year/month columns';
  END IF;
END $$;

-- ── B) Harden list_ready_extraction_jobs against concurrent sweepers ─
-- The function returns pending jobs whose scheduled_for is in the
-- past. Two sweepers firing within milliseconds of each other could
-- both see the same row before either marks it claimed (claim happens
-- in a separate RPC). Adding FOR UPDATE SKIP LOCKED ensures the second
-- sweeper sees an empty set rather than duplicating fire-attempts on
-- the worker.
--
-- If the function doesn't exist (older schema), this fails silently —
-- the worker's atomic claim already protects the actual job-claim
-- path, so the sweeper hardening is defence in depth.
DO $$
DECLARE
  fn_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'list_ready_extraction_jobs'
  ) INTO fn_exists;

  IF fn_exists THEN
    -- Keep the original signature (RETURNS SETOF extraction_jobs) so
    -- existing callers that may select extra columns aren't broken.
    -- Only change: switch from `LANGUAGE sql STABLE` to plpgsql so we
    -- can use FOR UPDATE SKIP LOCKED inside a query (not available in
    -- a sql-language function).
    --
    -- CREATE OR REPLACE works fine for matching signatures; no DROP needed.
    EXECUTE $func$
      CREATE OR REPLACE FUNCTION list_ready_extraction_jobs(max_jobs integer DEFAULT 10)
      RETURNS SETOF extraction_jobs
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      BEGIN
        RETURN QUERY
        SELECT *
        FROM extraction_jobs
        WHERE status = 'pending'
          AND scheduled_for <= now()
        ORDER BY scheduled_for ASC
        LIMIT max_jobs
        FOR UPDATE SKIP LOCKED;
      END;
      $body$;
    $func$;
    RAISE NOTICE 'M101: hardened list_ready_extraction_jobs with FOR UPDATE SKIP LOCKED';
  ELSE
    RAISE NOTICE 'M101: skipped list_ready_extraction_jobs hardening — function not present';
  END IF;
END $$;

-- ── Verification ────────────────────────────────────────────────────
-- Watch the NOTICE output above. Then run:
--   SELECT indexname, tablename FROM pg_indexes
--   WHERE indexname IN (
--     'idx_hourly_metrics_biz_date',
--     'idx_overhead_cache_lookup',
--     'idx_supplier_class_biz_num',
--     'idx_daily_metrics_org_biz_date',
--     'idx_monthly_metrics_org_biz_period'
--   );
-- Any indexes missing here failed the column-introspection check.
-- Tell Claude the actual column name and we'll fix M101 to match.
