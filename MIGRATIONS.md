# MIGRATIONS.md — CommandCenter Database Change Log
> Last updated: 2026-04-15 | Session 6
> Record every SQL change run in Supabase here. Never edit old entries — add new ones.

---

## How to use this file

When you run any SQL in the Supabase SQL Editor:
1. Add an entry below with the date, session, and exact SQL run
2. Mark whether it succeeded
3. Note any follow-up needed

This is the single source of truth for what the current schema looks like.

---

## Schema baseline (as of Session 5)

The following tables exist in production Supabase (llzmixkrysduztsvmfzi):

| Table | Key columns |
|-------|------------|
| organisations | id, name, plan, trial_ends_at, stripe_customer_id |
| organisation_members | org_id, user_id, role |
| businesses | id, org_id, name, city, is_active |
| integrations | id, org_id, business_id, provider, credentials_enc, status, last_sync_at, last_error |
| staff_logs | id, org_id, business_id, shift_date, staff_name, staff_group, staff_email, hours_worked, cost_actual, estimated_salary, ob_supplement_kr, ob_type, is_late, late_minutes, net_hours, breaks_seconds, real_start, real_stop, shift_start, shift_end, costgroup_name, costgroup_url, pk_log_url, pk_staff_url, pk_staff_id, pk_workplace_url, period_year, period_month |
| revenue_logs | id, org_id, business_id, revenue_date, revenue, covers, revenue_per_cover, transactions, tip_revenue, takeaway_revenue, dine_in_revenue, food_revenue, drink_revenue, provider |
| tracker_data | id, org_id, business_id, period_year, period_month, revenue, staff_cost, food_cost, drink_cost, rent, other_costs, net_profit |
| forecasts | id, org_id, business_id, period_year, period_month, revenue_forecast, staff_cost_forecast, margin_forecast |
| budgets | id, org_id, business_id, period_year, staff_budget, food_budget, drink_budget, rent_budget, other_budget |
| covers | id, org_id, business_id, date, total, revenue, revenue_per_cover |
| anomaly_alerts | id, org_id, business_id, alert_type, severity, title, description, metric_value, expected_value, deviation_pct, period_date, is_read, is_dismissed |
| gdpr_consents | id, org_id, user_id, consent_type, version, consented_at, withdrawn_at |
| deletion_requests | id, org_id, user_id, requested_at, status, completed_at, notes |
| onboarding_progress | id, org_id, step, metadata |

---

## Migration log

### M001 — 2026-04-10 — Session 5 — OB type and food/drink split
**Run**: 2026-04-10
**Status**: ✅ Success

```sql
ALTER TABLE staff_logs ADD COLUMN IF NOT EXISTS ob_type TEXT;
ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS food_revenue INTEGER DEFAULT 0;
ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS drink_revenue INTEGER DEFAULT 0;
```

---

### M002 — 2026-04-11 — Session 6 — AI query tracking
**Run**: 2026-04-11
**Status**: ✅ Success

```sql
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  query_count INTEGER DEFAULT 0,
  UNIQUE(org_id, date)
);
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_usage_daily_select_own" ON ai_usage_daily
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));
```

---

### M003 — 2026-04-15 — Session 6 — AI Agent Tables
**Run**: 2026-04-15
**Status**: ⏳ **PENDING** — Need to run in Supabase

```sql
-- Table for forecast calibration agent (runs 1st of month)
CREATE TABLE IF NOT EXISTS forecast_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at TIMESTAMPTZ DEFAULT now(),
  accuracy_pct NUMERIC,
  bias_factor NUMERIC DEFAULT 1.0,
  dow_factors JSONB,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forecast_calibration_select_own" ON forecast_calibration
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for scheduling optimization agent (runs weekly)
CREATE TABLE IF NOT EXISTS scheduling_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ DEFAULT now(),
  recommendations TEXT NOT NULL,
  analysis_period TEXT,
  metadata JSONB
);
ALTER TABLE scheduling_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scheduling_recommendations_select_own" ON scheduling_recommendations
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for Monday briefing agent (needs Resend)
CREATE TABLE IF NOT EXISTS briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  content TEXT NOT NULL,
  key_metrics JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, week_start)
);
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "briefings_select_own" ON briefings
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Column for onboarding success agent
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;
```

**Follow-up**: Run this SQL in Supabase SQL Editor before deploying AI agents.

---

### M005 — 2026-04-15 — Session 6 — Inzii POS department support
**Run**: 2026-04-15
**Status**: ✅ Success (department column) / ⏳ PENDING (constraint fix)

```sql
-- Step 1: Add department column (run first)
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS department TEXT;

-- Step 2: Replace single unique constraint with two partial indexes
-- Old constraint only allowed one integration per provider per business.
-- New indexes allow multiple Inzii rows (one per department) while keeping
-- the single-row-per-provider rule for all other integrations.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_business_id_provider_key;
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_org_business_provider_unique;

CREATE UNIQUE INDEX IF NOT EXISTS integrations_uniq_with_dept
  ON integrations (business_id, provider, department)
  WHERE department IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS integrations_uniq_no_dept
  ON integrations (business_id, provider)
  WHERE department IS NULL;
```

---

### M004 — 2026-04-15 — Session 6 — AI Agent Support Tables
**Run**: 2026-04-15
**Status**: ⏳ **PENDING** — Optional, for future agents

```sql
-- Table for supplier price creep agent (when Fortnox OAuth approved)
CREATE TABLE IF NOT EXISTS supplier_price_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  detected_at TIMESTAMPTZ DEFAULT now(),
  supplier_name TEXT,
  item_name TEXT,
  old_price NUMERIC,
  new_price NUMERIC,
  increase_pct NUMERIC,
  invoice_date DATE,
  alert_severity TEXT CHECK (alert_severity IN ('low', 'medium', 'high')),
  is_resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT
);
ALTER TABLE supplier_price_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_price_alerts_select_own" ON supplier_price_alerts
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for anomaly detection agent email tracking
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS email_recipients TEXT[];
```

---

## SQL to Run Now for AI Agents

Copy and paste this into Supabase SQL Editor:

```sql
-- M003: AI Agent Tables
CREATE TABLE IF NOT EXISTS forecast_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at TIMESTAMPTZ DEFAULT now(),
  accuracy_pct NUMERIC,
  bias_factor NUMERIC DEFAULT 1.0,
  dow_factors JSONB,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forecast_calibration_select_own" ON forecast_calibration
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

CREATE TABLE IF NOT EXISTS scheduling_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ DEFAULT now(),
  recommendations TEXT NOT NULL,
  analysis_period TEXT,
  metadata JSONB
);
ALTER TABLE scheduling_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scheduling_recommendations_select_own" ON scheduling_recommendations
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;

-- Mark as executed after running
-- ✅ EXECUTED 2026-04-15
```

---

## Current Schema Summary

### AI Agent Tables (Session 6)
1. **`ai_usage_daily`** — AI query limits per org per day
2. **`forecast_calibration`** — Forecast accuracy and bias factors (monthly)
3. **`scheduling_recommendations`** — Staff scheduling optimizations (weekly)
4. **`briefings`** — Monday briefing content (when Resend verified)
5. **`supplier_price_alerts`** — Supplier price increases (when Fortnox connected)

### Agent Status
- ✅ **Anomaly detection** — Live, uses `anomaly_alerts` table
- ✅ **Forecast calibration** — Ready, needs `forecast_calibration` table
- ✅ **Scheduling optimization** — Ready, needs `scheduling_recommendations` table
- ✅ **Supplier price creep** — Skeleton built, needs `supplier_price_alerts` table
- 🔄 **Onboarding success** — In progress, uses `onboarding_email_sent` column
- 📋 **Monday briefing** — Planned, needs `briefings` table

---

## Next Steps

1. **Run M003 SQL** in Supabase SQL Editor
2. **Deploy AI agents** to Vercel
3. **Test cron jobs** with Bearer token
4. **Monitor logs** for agent execution
5. **Update this file** with execution status

---

*Always update this file before and after running SQL in Supabase.*