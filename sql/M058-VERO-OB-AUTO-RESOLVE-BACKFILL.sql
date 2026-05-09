-- M058 — Backfill: auto-resolve Vero's repeated OB-supplement alerts
--
-- After M053 added the confirmation workflow and the detector got the
-- step-change auto-resolution patch (lib/alerts/detector.ts, commit
-- under PIECE-0-IMPLEMENTATION), Vero's existing 14 pending alerts
-- need triage. The simplest one-shot rule: if the SAME (business_id,
-- alert_type) appears more than once in the queue, only the OLDEST one
-- is the "real" notification. The newer ones are step-change
-- continuations and should be auto_resolved so the operator doesn't
-- have to click through all 14 cards.
--
-- This SQL is for-Vero-only (and any other org with the same backlog
-- pattern). It looks at every (business_id, alert_type) group with >1
-- pending row, keeps the FIRST one, and flips the rest to
-- auto_resolved.
--
-- See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream D.5b).
--
-- Run: open Supabase SQL Editor, paste this file, run. Idempotent —
-- subsequent runs find no rows to update because everything is already
-- resolved.

WITH ranked AS (
  SELECT
    id,
    business_id,
    alert_type,
    period_date,
    ROW_NUMBER() OVER (
      PARTITION BY business_id, alert_type
      ORDER BY period_date ASC
    ) AS rn
  FROM anomaly_alerts
  WHERE confirmation_status = 'pending'
    AND is_dismissed = false
)
UPDATE anomaly_alerts a
SET
  confirmation_status = 'auto_resolved',
  confirmed_at        = NOW(),
  confirmation_notes  = 'Backfill M058: auto-resolved as a step-change continuation. The earliest alert in this (business, alert_type) group remains pending for operator triage; this later fire is a duplicate of the same underlying pattern.'
FROM ranked
WHERE a.id = ranked.id
  AND ranked.rn > 1;

-- Sanity: show current state per (business_id, alert_type).
-- The first run should leave one 'pending' row per group + N
-- 'auto_resolved' rows. Re-running should change nothing.
SELECT
  business_id,
  alert_type,
  confirmation_status,
  COUNT(*) AS n,
  MIN(period_date) AS earliest_period,
  MAX(period_date) AS latest_period
FROM anomaly_alerts
WHERE is_dismissed = false
GROUP BY business_id, alert_type, confirmation_status
ORDER BY business_id, alert_type, confirmation_status;
