-- M059 — daily_forecast_outcomes (audit ledger for daily revenue forecasts)
--
-- Piece 1 of the prediction-system rebuild. Captures every prediction the
-- two legacy forecasters (scheduling-AI revenue + weather-demand) emit,
-- with the exact inputs they used, so a daily reconciler can pair each
-- prediction against the actual revenue once daily_metrics catches up.
--
-- This is the measurement infrastructure. Until it lands, nobody knows
-- whether the forecasters are accurate. After it lands, every prediction
-- gets logged and graded.
--
-- Phase A is "shadow mode" — the legacy forecasters keep their existing
-- response shape and behaviour; we just instrument them to also write
-- audit rows. Pieces 2-5 build on this ledger to ship the consolidated
-- forecaster, new signals, and LLM adjustment.
--
-- See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Section 2 (DDL)
-- and Section 5 (Capture and reconciliation).
--
-- Idempotent. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.daily_forecast_outcomes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  forecast_date DATE NOT NULL,

  surface     TEXT NOT NULL CHECK (surface IN (
    'consolidated_daily',     -- Piece 2 onwards
    'scheduling_ai_revenue',  -- legacy: /api/scheduling/ai-suggestion
    'weather_demand',         -- legacy: lib/weather/demand.ts
    'llm_adjusted'            -- Piece 4 onwards
  )),

  predicted_revenue INTEGER NOT NULL,
  baseline_revenue  INTEGER,

  first_predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  predicted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lead time (days). PostgreSQL date - date = integer. STORED so indexes work.
  prediction_horizon_days INTEGER GENERATED ALWAYS AS
    (forecast_date - first_predicted_at::date) STORED,

  model_version    TEXT  NOT NULL,
  snapshot_version TEXT  NOT NULL,
  inputs_snapshot  JSONB NOT NULL,

  llm_reasoning TEXT,
  confidence    TEXT CHECK (confidence IN ('high', 'medium', 'low')),

  actual_revenue    INTEGER,
  error_pct         NUMERIC(8, 4),
  error_attribution JSONB,
  resolved_at       TIMESTAMPTZ,
  resolution_status TEXT CHECK (resolution_status IN (
    'pending',
    'resolved',
    'unresolvable_no_actual',
    'unresolvable_data_quality',
    'unresolvable_zero_actual'
  )) DEFAULT 'pending',

  CONSTRAINT unique_forecast_per_day_per_surface
    UNIQUE (business_id, forecast_date, surface)
);

-- Hot lookups: "what did we predict for this business recently?"
CREATE INDEX IF NOT EXISTS idx_dfo_business_date
  ON public.daily_forecast_outcomes (business_id, forecast_date DESC);

-- Cross-business org-scoped reads (admin views).
CREATE INDEX IF NOT EXISTS idx_dfo_org_date
  ON public.daily_forecast_outcomes (org_id, forecast_date DESC);

-- Reconciler hot path — partial index on still-pending rows by date.
CREATE INDEX IF NOT EXISTS idx_dfo_pending_resolution
  ON public.daily_forecast_outcomes (forecast_date)
  WHERE resolution_status = 'pending';

-- Surface comparison ("how does scheduling_ai_revenue stack up vs weather_demand?")
CREATE INDEX IF NOT EXISTS idx_dfo_surface_business
  ON public.daily_forecast_outcomes (surface, business_id, forecast_date DESC);

-- MAPE-by-horizon analysis (Piece 4-5).
CREATE INDEX IF NOT EXISTS idx_dfo_horizon
  ON public.daily_forecast_outcomes (surface, prediction_horizon_days, forecast_date DESC)
  WHERE resolution_status = 'resolved';

-- ── RLS (matching M020 pattern verbatim) ────────────────────────────
ALTER TABLE public.daily_forecast_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_forecast_outcomes_read ON public.daily_forecast_outcomes;
CREATE POLICY daily_forecast_outcomes_read ON public.daily_forecast_outcomes
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
    )
  );

-- Service role bypasses RLS by default; no explicit write policy needed.
-- Operator-side UPDATEs are not supported in v1 (no UI writes to this
-- table — owners interact with anomaly_alerts.confirmation_status, which
-- the reconciler reads to gate baseline contamination).

-- ── Retention RPC (M020 pattern verbatim) ───────────────────────────
-- 3-year horizon to match ai_forecast_outcomes (prune_ai_forecast_outcomes).
-- Called from the new daily-forecast-reconciler cron on every run.
CREATE OR REPLACE FUNCTION public.prune_daily_forecast_outcomes()
RETURNS INT
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM public.daily_forecast_outcomes
    WHERE forecast_date < CURRENT_DATE - INTERVAL '3 years'
    RETURNING 1
  )
  SELECT COALESCE(COUNT(*)::int, 0) FROM deleted;
$$;

GRANT EXECUTE ON FUNCTION public.prune_daily_forecast_outcomes() TO service_role;

-- Sanity: confirm the table exists and is empty.
SELECT COUNT(*) AS daily_forecast_outcomes_rows FROM public.daily_forecast_outcomes;
