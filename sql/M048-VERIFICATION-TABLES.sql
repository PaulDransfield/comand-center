-- M048-VERIFICATION-TABLES.sql
-- ============================================================================
-- Phase 1 Fortnox API verification harness — mirror tables.
--
-- Purpose: hold API-derived metrics for Vero org (e917d4b8-635e-4be6-8af0-afc48c3c7450)
-- so we can compare them side-by-side with PDF-derived production metrics
-- WITHOUT touching production rows.
--
-- These tables are throwaway. Safe to TRUNCATE between verification runs.
-- Safe to DROP after Phase 1 is complete and the verification report is
-- archived. They do NOT participate in any application read path.
--
-- Schema cloned from production via `LIKE source INCLUDING ALL` so columns,
-- defaults, constraints, indexes match exactly. Foreign keys are deliberately
-- NOT copied (LIKE doesn't include them by default; we want isolation).
--
-- Notes:
--   • The Phase 1 prompt listed `vat_breakdown` as a table to mirror — that
--     table does NOT exist in production. The Swedish VAT-rate revenue split
--     lives as columns on tracker_data (`dine_in_revenue`, `takeaway_revenue`,
--     `alcohol_revenue`) per M029, not as a separate table. Skipped here.
--   • `tracker_line_items` was NOT in the prompt's mirror list but IS what
--     projectRollup writes alongside tracker_data. Included here because
--     line-item-level comparison is the only way to root-cause material drift.
--   • RLS not enabled on verification tables. They're harness-internal; only
--     the service role and verification scripts touch them.
-- ============================================================================

BEGIN;

-- ── Mirror tables ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS verification_tracker_data       (LIKE tracker_data       INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_tracker_line_items (LIKE tracker_line_items INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_monthly_metrics    (LIKE monthly_metrics    INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_daily_metrics      (LIKE daily_metrics      INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_dept_metrics       (LIKE dept_metrics       INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_revenue_logs       (LIKE revenue_logs       INCLUDING ALL);
CREATE TABLE IF NOT EXISTS verification_financial_logs     (LIKE financial_logs     INCLUDING ALL);

-- ── Run-tracking metadata table ──────────────────────────────────────────────
-- One row per verification run so we can correlate report output back to the
-- harness run that produced it (voucher count, date range, runtime, etc.).
CREATE TABLE IF NOT EXISTS verification_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_finished_at TIMESTAMPTZ,
  org_id          UUID NOT NULL,
  business_id     UUID,
  from_date       DATE NOT NULL,
  to_date         DATE NOT NULL,
  voucher_count   INTEGER,
  invoice_count   INTEGER,
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','failed')),
  error_message   TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_verification_runs_org_started
  ON verification_runs (org_id, run_started_at DESC);

-- ── Service-role policy helpers ──────────────────────────────────────────────
-- Verification tables do NOT have RLS enabled. The mirror tables inherit
-- whatever policies the LIKE clause carries; for daily_metrics, monthly_metrics,
-- dept_metrics that includes RLS-enabled + select-own + service-all policies.
-- That's fine for harness use — service role can read/write freely.
--
-- If a mirror table inherits a UNIQUE constraint that would conflict with
-- repeated runs (it will — every mirror has the same UNIQUE keys), the
-- harness must TRUNCATE before each run. Document that explicitly:
COMMENT ON TABLE verification_tracker_data IS
  'Phase 1 harness mirror of tracker_data. TRUNCATE before each run — UNIQUE(business_id, period_year, period_month) is preserved from LIKE.';
COMMENT ON TABLE verification_tracker_line_items IS
  'Phase 1 harness mirror of tracker_line_items. TRUNCATE before each run.';
COMMENT ON TABLE verification_monthly_metrics IS
  'Phase 1 harness mirror of monthly_metrics. TRUNCATE before each run.';
COMMENT ON TABLE verification_daily_metrics IS
  'Phase 1 harness mirror of daily_metrics. TRUNCATE before each run.';
COMMENT ON TABLE verification_dept_metrics IS
  'Phase 1 harness mirror of dept_metrics. TRUNCATE before each run.';
COMMENT ON TABLE verification_revenue_logs IS
  'Phase 1 harness mirror of revenue_logs. TRUNCATE before each run.';
COMMENT ON TABLE verification_financial_logs IS
  'Phase 1 harness mirror of financial_logs. TRUNCATE before each run.';

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name LIKE 'verification\_%'
 ORDER BY table_name;

COMMIT;

-- ── Drop script (when Phase 1 is archived) ───────────────────────────────────
-- Run this after the verification report is filed and the harness is no
-- longer needed:
--
--   DROP TABLE IF EXISTS verification_tracker_data       CASCADE;
--   DROP TABLE IF EXISTS verification_tracker_line_items CASCADE;
--   DROP TABLE IF EXISTS verification_monthly_metrics    CASCADE;
--   DROP TABLE IF EXISTS verification_daily_metrics      CASCADE;
--   DROP TABLE IF EXISTS verification_dept_metrics       CASCADE;
--   DROP TABLE IF EXISTS verification_revenue_logs       CASCADE;
--   DROP TABLE IF EXISTS verification_financial_logs     CASCADE;
--   DROP TABLE IF EXISTS verification_runs               CASCADE;
