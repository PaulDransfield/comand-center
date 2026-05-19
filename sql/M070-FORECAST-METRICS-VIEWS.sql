-- M070 — extended forecast measurement views
--
-- Phase 0 of the prediction-improvement plan. Before improving anything,
-- instrument. The existing v_forecast_mape_by_surface (M065) groups by
-- raw prediction_horizon_days — every horizon gets its own row, which is
-- fine for research queries but hard to read on a dashboard.
--
-- This migration adds three views layered on the same audit ledger:
--
--   v_forecast_mape_by_horizon_bucket — collapses raw horizon days into
--     four operational buckets (1, 7, 14, 28). The 7-day bucket covers
--     horizons 1-7 inclusive ("predictions made within the last week"),
--     14 covers 8-14, etc. Different decision-makers care about different
--     planning windows: staffing AI = 7d, /forecast page = 28d.
--
--   v_forecast_confidence_calibration — MAPE broken out by the forecaster's
--     self-reported confidence ('high' | 'medium' | 'low'). When a
--     forecaster reports confidence='high', what's the ACTUAL error rate?
--     If "high confidence" days run at the same MAPE as "low confidence"
--     days, the confidence label is broken and downstream consumers
--     (LLM auditor, UI confidence badge) get bad signal.
--
--   v_forecast_mape_rolling_28d — same shape as v_forecast_mape_by_surface
--     but filtered to forecast_date >= today - 28 days. The actionable
--     "is this getting better recently?" measure. The all-time view
--     dilutes recent improvements with historical baseline noise.
--
-- All views read from daily_forecast_outcomes and require resolution_status
-- = 'resolved' (skips pending, unresolvable_no_actual, unresolvable_zero,
-- and unresolvable_data_quality — those would pollute MAPE).
--
-- Idempotent — CREATE OR REPLACE.

-- ── 1. Bucketed horizon view ─────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_forecast_mape_by_horizon_bucket AS
WITH bucketed AS (
  SELECT
    business_id,
    surface,
    CASE
      WHEN prediction_horizon_days <= 1  THEN 1
      WHEN prediction_horizon_days <= 7  THEN 7
      WHEN prediction_horizon_days <= 14 THEN 14
      WHEN prediction_horizon_days <= 28 THEN 28
      ELSE 999
    END AS horizon_bucket_days,
    error_pct,
    forecast_date
  FROM public.daily_forecast_outcomes
  WHERE resolution_status = 'resolved'
    AND prediction_horizon_days >= 0
    AND error_pct IS NOT NULL
)
SELECT
  business_id,
  surface,
  horizon_bucket_days,
  COUNT(*)                                       AS resolved_rows,
  ROUND((AVG(ABS(error_pct)) * 100)::numeric, 1) AS mape_pct,
  ROUND((STDDEV(error_pct)   * 100)::numeric, 1) AS error_stddev_pct,
  ROUND((AVG(error_pct)      * 100)::numeric, 1) AS bias_pct,
  MIN(forecast_date)                             AS earliest_forecast,
  MAX(forecast_date)                             AS latest_forecast
FROM bucketed
WHERE horizon_bucket_days < 999
GROUP BY business_id, surface, horizon_bucket_days;

GRANT SELECT ON public.v_forecast_mape_by_horizon_bucket TO service_role;

-- ── 2. Confidence calibration view ───────────────────────────────────
CREATE OR REPLACE VIEW public.v_forecast_confidence_calibration AS
SELECT
  business_id,
  surface,
  confidence,
  COUNT(*)                                       AS resolved_rows,
  ROUND((AVG(ABS(error_pct)) * 100)::numeric, 1) AS mape_pct,
  ROUND((AVG(error_pct)      * 100)::numeric, 1) AS bias_pct,
  MIN(forecast_date)                             AS earliest_forecast,
  MAX(forecast_date)                             AS latest_forecast
FROM public.daily_forecast_outcomes
WHERE resolution_status = 'resolved'
  AND error_pct IS NOT NULL
  AND confidence IS NOT NULL
GROUP BY business_id, surface, confidence;

GRANT SELECT ON public.v_forecast_confidence_calibration TO service_role;

-- ── 3. Rolling 28-day MAPE view ──────────────────────────────────────
-- "Is the forecaster getting better recently?" The all-time view dilutes
-- recent gains with months of older data. Bound to forecast_date in the
-- last 28 calendar days; horizon-aware via the same bucket logic.
CREATE OR REPLACE VIEW public.v_forecast_mape_rolling_28d AS
WITH bucketed AS (
  SELECT
    business_id,
    surface,
    CASE
      WHEN prediction_horizon_days <= 1  THEN 1
      WHEN prediction_horizon_days <= 7  THEN 7
      WHEN prediction_horizon_days <= 14 THEN 14
      WHEN prediction_horizon_days <= 28 THEN 28
      ELSE 999
    END AS horizon_bucket_days,
    error_pct,
    forecast_date
  FROM public.daily_forecast_outcomes
  WHERE resolution_status = 'resolved'
    AND prediction_horizon_days >= 0
    AND error_pct IS NOT NULL
    AND forecast_date >= CURRENT_DATE - INTERVAL '28 days'
)
SELECT
  business_id,
  surface,
  horizon_bucket_days,
  COUNT(*)                                       AS resolved_rows,
  ROUND((AVG(ABS(error_pct)) * 100)::numeric, 1) AS mape_pct,
  ROUND((AVG(error_pct)      * 100)::numeric, 1) AS bias_pct,
  MIN(forecast_date)                             AS earliest_forecast,
  MAX(forecast_date)                             AS latest_forecast
FROM bucketed
WHERE horizon_bucket_days < 999
GROUP BY business_id, surface, horizon_bucket_days;

GRANT SELECT ON public.v_forecast_mape_rolling_28d TO service_role;

-- ── 4. Horizon × confidence breakdown ────────────────────────────────
-- Surfaces the question "are the rows in this MAPE bucket all short-horizon
-- (h=1) or spread across the forecasting window (h=1..28)?" — used to rule
-- out horizon-distribution artifacts when comparing surfaces.
--
-- Example: Phase 0 measurement showed Rosali weather_demand at 16.8% MAPE
-- (8 rows) vs consolidated_daily at 26.4% (11 rows). Likely artifact: legacy
-- weather_demand only captures h=1 ("today's revenue"), while the new
-- consolidated_daily captures h=1..7. This view confirms or refutes.
CREATE OR REPLACE VIEW public.v_forecast_horizon_confidence_breakdown AS
WITH bucketed AS (
  SELECT
    business_id,
    surface,
    confidence,
    CASE
      WHEN prediction_horizon_days <= 1  THEN 1
      WHEN prediction_horizon_days <= 7  THEN 7
      WHEN prediction_horizon_days <= 14 THEN 14
      WHEN prediction_horizon_days <= 28 THEN 28
      ELSE 999
    END AS horizon_bucket_days,
    error_pct,
    forecast_date
  FROM public.daily_forecast_outcomes
  WHERE resolution_status = 'resolved'
    AND prediction_horizon_days >= 0
    AND error_pct IS NOT NULL
    AND confidence IS NOT NULL
)
SELECT
  business_id,
  surface,
  confidence,
  horizon_bucket_days,
  COUNT(*)                                       AS resolved_rows,
  ROUND((AVG(ABS(error_pct)) * 100)::numeric, 1) AS mape_pct,
  ROUND((AVG(error_pct)      * 100)::numeric, 1) AS bias_pct,
  MIN(forecast_date)                             AS earliest_forecast,
  MAX(forecast_date)                             AS latest_forecast
FROM bucketed
WHERE horizon_bucket_days < 999
GROUP BY business_id, surface, confidence, horizon_bucket_days;

GRANT SELECT ON public.v_forecast_horizon_confidence_breakdown TO service_role;

-- ── Verification queries ─────────────────────────────────────────────
SELECT
  business_id,
  surface,
  horizon_bucket_days,
  resolved_rows,
  mape_pct,
  bias_pct
FROM public.v_forecast_mape_by_horizon_bucket
ORDER BY business_id, surface, horizon_bucket_days
LIMIT 30;

SELECT
  business_id,
  surface,
  confidence,
  resolved_rows,
  mape_pct,
  bias_pct
FROM public.v_forecast_confidence_calibration
ORDER BY business_id, surface, confidence
LIMIT 30;

SELECT
  business_id,
  surface,
  confidence,
  horizon_bucket_days,
  resolved_rows,
  mape_pct,
  bias_pct
FROM public.v_forecast_horizon_confidence_breakdown
ORDER BY business_id, surface, confidence, horizon_bucket_days
LIMIT 50;
