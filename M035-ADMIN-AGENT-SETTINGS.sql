-- M035-ADMIN-AGENT-SETTINGS.sql
-- ============================================================================
-- Per-agent global kill switch table for the admin v2 Agents tab.
--
-- Pre-this migration there's no global "is this agent active" record. The
-- existing feature_flags table holds PER-ORG disables, not a global cron
-- kill. Admin v2 PR 6 needs a single switch the admin can flip when an
-- agent is misbehaving without having to touch every org's flag row or
-- pause the Vercel cron manually.
--
-- Behaviour:
--   - agent_settings holds one row per known agent key
--   - is_active=false is the kill-switch state
--   - last_changed_at + last_change_reason are the audit complement (the
--     full audit trail still goes to admin_audit_log; this is an at-a-
--     glance "who killed it last" surface in the agents list)
--
-- Cron handlers DO NOT yet check this column — that's a follow-up. PR 6
-- ships the table + admin surface so the kill switch is visible. Wiring
-- the crons to honour `is_active=false` is a subsequent small PR.
--
-- Safety: CREATE TABLE IF NOT EXISTS, idempotent INSERT … ON CONFLICT.
-- RLS enabled with no policy → service-role only.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS agent_settings (
  key                TEXT PRIMARY KEY,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  last_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_changed_by    TEXT,                                  -- 'admin' for now
  last_change_reason TEXT
);

ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT policy → only the service role (admin client) can read/write.

-- Seed the known agent keys. Idempotent — re-runs are no-ops.
INSERT INTO agent_settings (key, is_active) VALUES
  ('anomaly_detection',       true),
  ('forecast_calibration',    true),
  ('scheduling_optimization', true),
  ('monday_briefing',         true),
  ('onboarding_success',      true),
  ('supplier_price_creep',    true)
ON CONFLICT (key) DO NOTHING;

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT key, is_active, last_changed_at FROM agent_settings ORDER BY key;
-- Expected: 6 rows, all is_active=true, last_changed_at set to migration time.

COMMIT;
