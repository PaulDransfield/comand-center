-- M065 — v_forecast_mape_by_surface comparison view
--
-- Phase A acceptance gate for Piece 2: side-by-side MAPE-by-horizon
-- across all three forecaster surfaces:
--   - consolidated_daily      (Piece 2 — new)
--   - scheduling_ai_revenue   (legacy — /api/scheduling/ai-suggestion)
--   - weather_demand          (legacy — lib/weather/demand.ts)
--
-- The reconciler grades resolved rows daily; this view aggregates the
-- error_pct field into MAPE (mean absolute percentage error) and STDDEV
-- per (business, surface, horizon). Phase B cutover criterion (architecture
-- §11): consolidated_daily MAPE must be within 2pp of the better legacy
-- surface AND no horizon shows >20% MAPE divergence between surfaces.
--
-- Idempotent — CREATE OR REPLACE.

CREATE OR REPLACE VIEW public.v_forecast_mape_by_surface AS
SELECT
  business_id,
  surface,
  prediction_horizon_days,
  COUNT(*)                                        AS resolved_rows,
  ROUND(AVG(ABS(error_pct))::numeric * 100, 1)    AS mape_pct,
  ROUND(STDDEV(error_pct)::numeric * 100, 1)      AS error_stddev_pct,
  -- Bias = mean(error_pct) — positive means we OVER-predict on average,
  -- negative means UNDER-predict. Helpful complement to MAPE.
  ROUND(AVG(error_pct)::numeric * 100, 1)         AS bias_pct,
  MIN(forecast_date)                              AS earliest_forecast,
  MAX(forecast_date)                              AS latest_forecast
FROM public.daily_forecast_outcomes
WHERE resolution_status = 'resolved'
  AND prediction_horizon_days BETWEEN 0 AND 14
  AND error_pct IS NOT NULL
GROUP BY business_id, surface, prediction_horizon_days;

GRANT SELECT ON public.v_forecast_mape_by_surface TO service_role;

-- Verification
SELECT business_id, surface, prediction_horizon_days, resolved_rows, mape_pct, bias_pct
FROM public.v_forecast_mape_by_surface
ORDER BY business_id, surface, prediction_horizon_days
LIMIT 50;
