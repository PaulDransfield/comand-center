-- M008 — Summary tables for pre-computed metrics
-- Run in Supabase SQL Editor
-- These tables are the single source of truth for all pages.
-- Raw tables (staff_logs, revenue_logs) are kept as audit trail.

-- ═══════════════════════════════════════════════════════════════════
-- 1. daily_metrics — one row per business per day
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS daily_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date          DATE NOT NULL,

  -- Revenue (from revenue_logs — POS sync)
  revenue       INTEGER NOT NULL DEFAULT 0,
  covers        INTEGER NOT NULL DEFAULT 0,
  rev_per_cover INTEGER NOT NULL DEFAULT 0,
  tips          INTEGER NOT NULL DEFAULT 0,
  food_revenue  INTEGER NOT NULL DEFAULT 0,
  bev_revenue   INTEGER NOT NULL DEFAULT 0,
  dine_in       INTEGER NOT NULL DEFAULT 0,
  takeaway      INTEGER NOT NULL DEFAULT 0,

  -- Staff cost (from staff_logs — PK sync)
  staff_cost    INTEGER NOT NULL DEFAULT 0,
  hours_worked  NUMERIC(8,1) NOT NULL DEFAULT 0,
  shifts        INTEGER NOT NULL DEFAULT 0,
  late_shifts   INTEGER NOT NULL DEFAULT 0,
  ob_supplement INTEGER NOT NULL DEFAULT 0,

  -- Derived
  labour_pct    NUMERIC(5,1),  -- staff_cost / revenue * 100

  -- Provenance
  rev_source    TEXT NOT NULL DEFAULT 'none',  -- 'pos', 'manual', 'fortnox', 'none'
  cost_source   TEXT NOT NULL DEFAULT 'none',  -- 'pk', 'manual', 'fortnox', 'none'

  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_org    ON daily_metrics(org_id);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_biz    ON daily_metrics(business_id, date);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date   ON daily_metrics(date);

ALTER TABLE daily_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily_metrics_select_own" ON daily_metrics
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));


-- ═══════════════════════════════════════════════════════════════════
-- 2. monthly_metrics — one row per business per month
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS monthly_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  month         INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- Revenue
  revenue       INTEGER NOT NULL DEFAULT 0,
  covers        INTEGER NOT NULL DEFAULT 0,
  tips          INTEGER NOT NULL DEFAULT 0,
  food_revenue  INTEGER NOT NULL DEFAULT 0,
  bev_revenue   INTEGER NOT NULL DEFAULT 0,

  -- Costs
  staff_cost    INTEGER NOT NULL DEFAULT 0,
  food_cost     INTEGER NOT NULL DEFAULT 0,  -- from Fortnox (4xxx accounts) or manual
  rent_cost     INTEGER NOT NULL DEFAULT 0,  -- from Fortnox (5xxx accounts) or manual
  other_cost    INTEGER NOT NULL DEFAULT 0,  -- from Fortnox or manual
  total_cost    INTEGER NOT NULL DEFAULT 0,  -- sum of all costs

  -- Staff detail
  hours_worked  NUMERIC(8,1) NOT NULL DEFAULT 0,
  shifts        INTEGER NOT NULL DEFAULT 0,
  late_shifts   INTEGER NOT NULL DEFAULT 0,
  ob_supplement INTEGER NOT NULL DEFAULT 0,

  -- P&L derived
  net_profit    INTEGER NOT NULL DEFAULT 0,  -- revenue - total_cost
  margin_pct    NUMERIC(5,1) NOT NULL DEFAULT 0,
  labour_pct    NUMERIC(5,1),
  food_pct      NUMERIC(5,1),

  -- Provenance
  rev_source    TEXT NOT NULL DEFAULT 'none',
  cost_source   TEXT NOT NULL DEFAULT 'none',

  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_metrics_org  ON monthly_metrics(org_id);
CREATE INDEX IF NOT EXISTS idx_monthly_metrics_biz  ON monthly_metrics(business_id, year);

ALTER TABLE monthly_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "monthly_metrics_select_own" ON monthly_metrics
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));


-- ═══════════════════════════════════════════════════════════════════
-- 3. dept_metrics — one row per department per month
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dept_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  dept_name     TEXT NOT NULL,
  year          INTEGER NOT NULL,
  month         INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- Revenue (from revenue_logs where provider = 'pk_<dept>' or 'inzii_<dept>')
  revenue       INTEGER NOT NULL DEFAULT 0,
  covers        INTEGER NOT NULL DEFAULT 0,

  -- Staff cost (from staff_logs where staff_group = dept_name)
  staff_cost    INTEGER NOT NULL DEFAULT 0,
  hours_worked  NUMERIC(8,1) NOT NULL DEFAULT 0,
  shifts        INTEGER NOT NULL DEFAULT 0,
  late_shifts   INTEGER NOT NULL DEFAULT 0,
  ob_supplement INTEGER NOT NULL DEFAULT 0,

  -- Derived
  labour_pct    NUMERIC(5,1),
  gp_pct        NUMERIC(5,1),

  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, dept_name, year, month)
);

CREATE INDEX IF NOT EXISTS idx_dept_metrics_org  ON dept_metrics(org_id);
CREATE INDEX IF NOT EXISTS idx_dept_metrics_biz  ON dept_metrics(business_id, year);

ALTER TABLE dept_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dept_metrics_select_own" ON dept_metrics
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));


-- ═══════════════════════════════════════════════════════════════════
-- Service role policies (for the sync/aggregation functions)
-- ═══════════════════════════════════════════════════════════════════
-- Allow service role to INSERT/UPDATE/DELETE (admin client uses service key)
CREATE POLICY "daily_metrics_service_all" ON daily_metrics FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "monthly_metrics_service_all" ON monthly_metrics FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "dept_metrics_service_all" ON dept_metrics FOR ALL USING (true) WITH CHECK (true);
