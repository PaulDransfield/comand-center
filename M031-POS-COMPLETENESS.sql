-- M031-POS-COMPLETENESS.sql
-- ============================================================================
-- Add `pos_days_with_revenue` to monthly_metrics so the data merge layer
-- can tell when POS data is PARTIAL (e.g. PK integration was added mid-month
-- and only captured the latter weeks).
--
-- Pre-fix scenario: Vero Nov 2025 had POS revenue 476k (29% of full month)
-- because PK only synced the second half. Fortnox tracker_data correctly
-- showed 1 624k. /api/tracker preferred POS over Fortnox blindly, producing
-- absurd −137 % margins on the Performance page (full-month Fortnox costs
-- against partial-month POS revenue).
--
-- This migration adds the completeness signal, backfills it from
-- daily_metrics, and lets /api/tracker decide source priority based on
-- actual day-coverage rather than "non-zero means complete". See FIXES.md
-- §0r and the data-completeness change in /api/tracker/route.ts.
-- ============================================================================

BEGIN;

-- ── Add the column ──────────────────────────────────────────────────────────
-- Counts the number of distinct calendar days within (year, month) where
-- daily_metrics has a positive revenue value. Range 0-31. /api/tracker
-- compares this against the calendar days in that month to compute
-- completeness. ≥90 % → trust POS revenue, else fall back to Fortnox.
ALTER TABLE monthly_metrics
  ADD COLUMN IF NOT EXISTS pos_days_with_revenue INT NOT NULL DEFAULT 0;

-- Index keeps the per-month read fast even if monthly_metrics grows large.
CREATE INDEX IF NOT EXISTS idx_monthly_metrics_pos_days
  ON monthly_metrics (business_id, year, month, pos_days_with_revenue);

-- ── Backfill from daily_metrics ─────────────────────────────────────────────
-- Count distinct dates per (business, year-month) where revenue > 0.
WITH coverage AS (
  SELECT business_id,
         EXTRACT(YEAR  FROM date)::int AS year,
         EXTRACT(MONTH FROM date)::int AS month,
         COUNT(DISTINCT date) FILTER (WHERE revenue > 0) AS days_with_revenue
    FROM daily_metrics
   GROUP BY business_id, year, month
)
UPDATE monthly_metrics mm
   SET pos_days_with_revenue = c.days_with_revenue
  FROM coverage c
 WHERE mm.business_id = c.business_id
   AND mm.year         = c.year
   AND mm.month        = c.month;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Show a sample: any month where POS coverage is < 90 % of expected days
-- (these are the rows where /api/tracker will now prefer Fortnox over POS).
SELECT mm.business_id,
       mm.year, mm.month,
       mm.revenue       AS pos_revenue,
       mm.pos_days_with_revenue,
       EXTRACT(DAY FROM (DATE_TRUNC('month', make_date(mm.year, mm.month, 1))
                       + interval '1 month' - interval '1 day'))::int AS calendar_days,
       ROUND(100.0 * mm.pos_days_with_revenue
             / EXTRACT(DAY FROM (DATE_TRUNC('month', make_date(mm.year, mm.month, 1))
                                + interval '1 month' - interval '1 day')), 1) AS coverage_pct
  FROM monthly_metrics mm
 WHERE mm.year = 2025
   AND mm.pos_days_with_revenue > 0
 ORDER BY mm.business_id, mm.year, mm.month;

COMMIT;
