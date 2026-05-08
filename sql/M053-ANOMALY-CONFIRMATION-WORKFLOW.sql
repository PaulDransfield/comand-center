-- M053 — anomaly_alerts confirmation workflow
--
-- Adds the four columns that let an operator confirm or reject an alert,
-- so the prediction system's reconciler in Piece 1 can know which past
-- anomalies were real (and should be excluded from baselines as
-- contaminated data) vs which were false alarms.
--
-- Decision context: the v1 + v2 architecture reviews caught two
-- "fabricated column" bugs (`status='confirmed'`, `metric='revenue'`)
-- that would have crashed reconciler queries on first run. The actual
-- table has `is_dismissed` / `is_read` but no operator-confirm action.
-- This migration adds the missing column triple deliberately rather
-- than smearing semantics across `is_read`/`is_dismissed`.
--
-- See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream D).
--
-- Run: open Supabase SQL Editor, paste this file, run. Idempotent
-- (`IF NOT EXISTS` everywhere) so safe to re-run.

ALTER TABLE anomaly_alerts
  ADD COLUMN IF NOT EXISTS confirmation_status TEXT
    CHECK (confirmation_status IN ('pending', 'confirmed', 'rejected', 'auto_resolved'))
    DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS confirmed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by        UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS confirmation_notes  TEXT;

-- Partial index — the reconciler in Piece 1 will filter on
-- confirmation_status='confirmed' to identify "real anomalies that
-- should be excluded from baseline computations." Partial keeps the
-- index small (only confirmed rows are indexed; pending rows are the
-- common case and don't need this scan).
CREATE INDEX IF NOT EXISTS idx_anomaly_alerts_confirmation
  ON anomaly_alerts (business_id, period_date, confirmation_status)
  WHERE confirmation_status = 'confirmed';

-- Sanity: every existing row should default to 'pending' after this runs.
SELECT confirmation_status, COUNT(*) AS row_count
FROM anomaly_alerts
GROUP BY confirmation_status
ORDER BY 1;
