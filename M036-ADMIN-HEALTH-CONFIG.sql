-- M036-ADMIN-HEALTH-CONFIG.sql
-- ============================================================================
-- Admin v2 Health tab support — two pieces:
--
--   1. cron_run_log table + index. Cron handlers wrap their work in
--      lib/cron/log.ts to record start/end. Health tab reads the most-
--      recent run per cron_name. Wiring is per-cron-handler in a small
--      follow-up PR.
--
--   2. admin_health_rls() RPC. Returns one row per public-schema table
--      with rowsecurity flag + policy count. Used by the Health tab's
--      RLS section to flag anomalies (RLS enabled but 0 policies → full
--      lockout). Read-only, SECURITY DEFINER so service role can read
--      pg_catalog. Returns SETOF a clean named composite type so the
--      caller doesn't need to know catalog quirks.
-- ============================================================================

BEGIN;

-- ── 1. cron_run_log ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cron_run_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name   TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status      TEXT,                            -- 'success' | 'error' | 'running'
  error       TEXT,
  meta        JSONB
);

-- Hot lookup: latest run per cron_name.
CREATE INDEX IF NOT EXISTS idx_cron_run_log_name_started
  ON cron_run_log (cron_name, started_at DESC);

-- Secondary: status filter for failure listings.
CREATE INDEX IF NOT EXISTS idx_cron_run_log_status_started
  ON cron_run_log (status, started_at DESC);

ALTER TABLE cron_run_log ENABLE ROW LEVEL SECURITY;
-- Service-role only — no policy needed.

-- ── 2. RLS health RPC ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_health_rls()
RETURNS TABLE(
  table_name     TEXT,
  rls_enabled    BOOLEAN,
  policy_count   INTEGER,
  is_anomaly     BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    t.tablename::TEXT                                                   AS table_name,
    t.rowsecurity                                                       AS rls_enabled,
    COALESCE((SELECT COUNT(*)::INTEGER
                FROM pg_policies p
               WHERE p.schemaname = t.schemaname
                 AND p.tablename  = t.tablename), 0)                    AS policy_count,
    -- Anomaly: RLS enabled but no policies → table is fully locked
    -- to the anon/authenticated roles.
    (t.rowsecurity AND
     COALESCE((SELECT COUNT(*) FROM pg_policies p
               WHERE p.schemaname = t.schemaname
                 AND p.tablename  = t.tablename), 0) = 0)               AS is_anomaly
  FROM pg_tables t
  WHERE t.schemaname = 'public'
  ORDER BY t.tablename;
$$;

REVOKE ALL ON FUNCTION admin_health_rls() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_health_rls() TO service_role;

COMMENT ON FUNCTION admin_health_rls() IS
  'Per public-schema table: name, RLS state, policy count, anomaly flag (RLS-on with zero policies). Read-only, service-role only.';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT 'cron_run_log' AS object, pg_relation_size('cron_run_log') AS size_bytes;
SELECT proname FROM pg_proc WHERE proname = 'admin_health_rls';
SELECT * FROM admin_health_rls() WHERE is_anomaly = true LIMIT 5;
-- Anomaly rows (if any) should surface in the Admin v2 Health tab.

COMMIT;
