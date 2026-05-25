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
-- Safe to re-run: every CREATE INDEX is IF NOT EXISTS, every CREATE
-- OR REPLACE FUNCTION replaces the body atomically.

-- ── A.1) hourly_metrics composite index ────────────────────────────
-- Hot path: lib/forecast/hourly.ts loads 12 weeks of hourly history
-- per forecast call. /api/scheduling/ai-recommend builds the per-
-- weekday-per-hour demand profile from a 12-week SELECT here.
-- 24 rows × 365 days × 20 customers = 175k rows/year/business.
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_biz_date
  ON hourly_metrics (business_id, business_date);

-- ── A.2) overhead_drilldown_cache lookup index ──────────────────────
-- Hot path: /api/integrations/fortnox/drilldown does eq on all 4
-- columns to find a cached entry. /api/overheads/explain uses the same
-- key during AI cache enrichment. 5-min TTL means every page mount
-- triggers a lookup; no index = scan.
CREATE INDEX IF NOT EXISTS idx_overhead_cache_lookup
  ON overhead_drilldown_cache (business_id, period_year, period_month, category);

-- ── A.3) supplier_classifications lookup index ──────────────────────
-- Hot path: lib/inventory/matcher.ts gate-0 checks the per-business
-- override BEFORE BAS-account routing. Called once per invoice line
-- during bulk-review or PDF apply. 20 customers × 500 lines/month =
-- 10k lookups/month even at modest scale.
CREATE INDEX IF NOT EXISTS idx_supplier_class_biz_num
  ON supplier_classifications (business_id, supplier_fortnox_number);

-- ── A.4) daily_metrics composite index ──────────────────────────────
-- M034 covered revenue_logs + staff_logs but not daily_metrics, which
-- is the table the dashboard reads on every page load. RLS policy
-- evaluates per-row; without the composite, queries scan all 20-org
-- rows even when filtered to one business.
CREATE INDEX IF NOT EXISTS idx_daily_metrics_org_biz_date
  ON daily_metrics (org_id, business_id, business_date);

-- ── A.5) monthly_metrics composite index ────────────────────────────
-- Same pattern as A.4 for monthly_metrics. Tracker / overheads /
-- budgets all read this; RLS lookup needs the composite for fast scans.
CREATE INDEX IF NOT EXISTS idx_monthly_metrics_org_biz_period
  ON monthly_metrics (org_id, business_id, period_year, period_month);

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
    -- Replace with FOR UPDATE SKIP LOCKED variant. We don't actually
    -- claim the row here (the worker's claim_next_extraction_job does
    -- that with its own FOR UPDATE) — SKIP LOCKED just means a
    -- concurrent sweeper sees nothing while we read, so it doesn't
    -- also try to fire a worker for the same id.
    EXECUTE $func$
      CREATE OR REPLACE FUNCTION list_ready_extraction_jobs(max_jobs integer DEFAULT 10)
      RETURNS TABLE (
        id          uuid,
        upload_id   uuid,
        attempts    integer,
        scheduled_for timestamptz
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      BEGIN
        RETURN QUERY
        SELECT j.id, j.upload_id, j.attempts, j.scheduled_for
        FROM extraction_jobs j
        WHERE j.status = 'pending'
          AND j.scheduled_for <= now()
        ORDER BY j.scheduled_for ASC, j.created_at ASC
        LIMIT max_jobs
        FOR UPDATE SKIP LOCKED;
      END;
      $body$;
    $func$;
  END IF;
END $$;

-- Done. Verify with:
--   SELECT indexname FROM pg_indexes WHERE indexname IN (
--     'idx_hourly_metrics_biz_date',
--     'idx_overhead_cache_lookup',
--     'idx_supplier_class_biz_num',
--     'idx_daily_metrics_org_biz_date',
--     'idx_monthly_metrics_org_biz_period'
--   );
