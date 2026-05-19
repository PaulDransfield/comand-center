-- M071 — hourly_metrics table
--
-- Phase A week 1 of the Nordic Plan. PK already exposes per-sale data with
-- `sale_time` timestamps via /sales/; we currently aggregate everything to
-- daily (revenue_logs / daily_metrics) and throw away the within-day signal.
-- This table preserves it.
--
-- Each row is one (business × calendar_date × hour-of-day) cell in Stockholm
-- local time. Stockholm-local because operators think in shifts: "lunch is
-- 12-14, dinner 17-22." A 01:30 sale belongs to the previous service period
-- regardless of UTC. The `business_date` column is the Stockholm calendar
-- date of the hour bucket; `hour` is 0-23 in Stockholm time.
--
-- Why a separate table (not extend daily_metrics):
--   - 24× row volume — pushes vertical scan costs on the daily aggregator
--   - Different consumers (hourly forecaster, meal-period rollups) shouldn't
--     have to filter daily_metrics against null-hour rows
--   - Lets daily_metrics keep its existing index + access patterns intact
--
-- Idempotent — re-running is safe. INSERTS use ON CONFLICT for the sync
-- engine's upsert path; the index is non-partial so PostgREST onConflict
-- works without surprises (per the M049 lesson).
--
-- See THE-NORDIC-PLAN.md Phase A week 1 for the rest of the sprint scope.

CREATE TABLE IF NOT EXISTS public.hourly_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,

  -- Stockholm-local calendar date this hour belongs to.
  business_date DATE NOT NULL,
  -- Hour-of-day in Stockholm time, 0-23.
  hour          SMALLINT NOT NULL CHECK (hour >= 0 AND hour <= 23),

  -- NET ex-VAT revenue summed across all sales in this hour (matches PK
  -- dashboard "Försäljning ex. moms"). Same accounting basis as revenue_logs.
  revenue          NUMERIC(12, 2) NOT NULL DEFAULT 0,
  covers           INTEGER         NOT NULL DEFAULT 0,
  transactions     INTEGER         NOT NULL DEFAULT 0,

  -- VAT-coded revenue splits (Swedish tax code):
  --   food_revenue     — dine-in food (12 % VAT)
  --   bev_revenue      — alcohol / soft drinks (25 % VAT)
  --   takeaway_revenue — takeaway food (6 % VAT)
  --   dine_in_revenue  — sum of 12 % + 25 % rows
  food_revenue      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  bev_revenue       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  takeaway_revenue  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  dine_in_revenue   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tip_revenue       NUMERIC(12, 2) NOT NULL DEFAULT 0,

  -- Cost-of-goods-sold for the hour (from PK product master where set).
  cogs_amount       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  -- Revenue coverage of the COGS estimate — what fraction of revenue had a
  -- product purchase_price available. Below ~80 % means the COGS figure
  -- is unreliable for that hour.
  cogs_coverage     NUMERIC(12, 2) NOT NULL DEFAULT 0,

  -- Source provider — same enum semantics as revenue_logs.provider. Useful
  -- when we add Onslip/Caspeco hourly later.
  provider          TEXT NOT NULL DEFAULT 'personalkollen',

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT hourly_metrics_unique UNIQUE (business_id, business_date, hour, provider)
);

-- Hot lookups: per-business range scan (forecast horizon queries).
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_business_date
  ON public.hourly_metrics (business_id, business_date DESC, hour);

-- Org-scoped reads for admin views and cross-business analytics.
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_org_date
  ON public.hourly_metrics (org_id, business_date DESC);

-- Meal-period rollup queries: SELECT … WHERE hour BETWEEN 11 AND 14.
-- Partial index keeps the cost low because most rows have revenue > 0.
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_hour_business
  ON public.hourly_metrics (business_id, hour)
  WHERE revenue > 0;

-- ── RLS (matches M020 / M059 pattern) ────────────────────────────────
ALTER TABLE public.hourly_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hourly_metrics_read ON public.hourly_metrics;
CREATE POLICY hourly_metrics_read ON public.hourly_metrics
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
    )
  );

-- Service role bypasses RLS by default; sync engine writes via service role.

-- ── updated_at trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hourly_metrics_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hourly_metrics_touch_updated_at ON public.hourly_metrics;
CREATE TRIGGER hourly_metrics_touch_updated_at
  BEFORE UPDATE ON public.hourly_metrics
  FOR EACH ROW EXECUTE FUNCTION public.hourly_metrics_touch_updated_at();

-- Verification: count rows + show a couple if any exist.
SELECT COUNT(*) AS hourly_metrics_rows FROM public.hourly_metrics;
SELECT business_id, business_date, hour, revenue, covers, transactions
FROM public.hourly_metrics
ORDER BY business_date DESC, hour DESC
LIMIT 10;
