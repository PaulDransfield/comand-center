-- scripts/flip-prediction-v2-dashboard-chart-vero.sql
--
-- Activates Piece 2 (consolidated_v1.3.0) as the revenue prediction source
-- for Vero Italiano's dashboard chart + scheduling-AI suggestion. Once this
-- runs, the revenue line on the dashboard, the AI-suggested hours, and the
-- "what's the typical day" reasoning will all source from dailyForecast()
-- instead of the legacy weekday-weighted-avg × scaler math.
--
-- Pre-cutover MAPE (2026-05-11 backtest, n=116):
--   consolidated_daily        MAPE 64.6 %  bias +13.9 %  Nov 24 - Mar 31
--   scheduling_ai_revenue     n=1 only (no apples-to-apples)
--
-- This is per-business — flipping it for Vero leaves everyone else on the
-- legacy revenue forecaster. To roll back: UPDATE ... SET enabled = false
-- (don't DELETE — preserves the audit trail of when it was flipped).
--
-- Cron-side: dailyForecast() captures surface='consolidated_daily' on every
-- call, so MAPE-by-surface comparison continues. The reconciler at 10:00
-- UTC pairs predictions to actuals automatically.
--
-- Apply via Supabase SQL Editor against the production database, OR run
-- from CLI as:
--   psql "$DATABASE_URL" -f scripts/flip-prediction-v2-dashboard-chart-vero.sql

-- Vero Italiano
INSERT INTO business_feature_flags (business_id, flag, enabled, created_at, updated_at)
VALUES (
  '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99',
  'PREDICTION_V2_DASHBOARD_CHART',
  true,
  NOW(),
  NOW()
)
ON CONFLICT (business_id, flag) DO UPDATE SET enabled = true, updated_at = NOW();

-- Confirm
SELECT business_id, flag, enabled, updated_at
FROM business_feature_flags
WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
  AND flag = 'PREDICTION_V2_DASHBOARD_CHART';
