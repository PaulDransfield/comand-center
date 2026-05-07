-- M051-OVERHEAD-DRILLDOWN-CACHE.sql
-- ============================================================================
-- Owner-facing drill-down on overhead-review flags. When the owner clicks
-- "Show invoices" on a flagged supplier card, /api/integrations/fortnox/drilldown
-- fetches voucher + supplier-invoice data live from Fortnox for the relevant
-- (period, category), groups by supplier, and caches the response here for
-- 5 minutes so subsequent clicks within the same flag set don't re-hit Fortnox.
--
-- Cache key is (business_id, period_year, period_month, category) — NOT
-- (supplier) — so that a single Fortnox fetch serves all the flags in the
-- same category for the same month. The client filters to the relevant
-- supplier when rendering.
--
-- Idempotent — Paul applied the table directly via SQL editor on 2026-05-07
-- before the migration file was written. Re-running this migration is safe.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS overhead_drilldown_cache (
  business_id    UUID NOT NULL,
  period_year    INT  NOT NULL,
  period_month   INT  NOT NULL,
  category       TEXT NOT NULL,
  payload        JSONB NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, period_year, period_month, category)
);

COMMENT ON TABLE overhead_drilldown_cache IS
  'Five-minute cache of /api/integrations/fortnox/drilldown payloads, keyed by (business_id, period_year, period_month, category). Eviction is lazy — the endpoint checks fetched_at on read and re-fetches if stale.';

-- Service role policy — only the route + admin client touch this table.
ALTER TABLE overhead_drilldown_cache ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'overhead_drilldown_cache'
       AND policyname = 'overhead_drilldown_cache_service_all'
  ) THEN
    CREATE POLICY overhead_drilldown_cache_service_all ON overhead_drilldown_cache
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'overhead_drilldown_cache'
 ORDER BY ordinal_position;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS overhead_drilldown_cache;
