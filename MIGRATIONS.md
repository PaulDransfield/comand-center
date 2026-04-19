# MIGRATIONS.md — CommandCenter Database Change Log
> Last updated: 2026-04-19 | M015 (weather_daily) pending
> Record every SQL change run in Supabase here. Never edit old entries — add new ones.

---

## Pending — apply when ready

### M015 — weather_daily
**File:** `sql/M015-weather-daily.sql`
**Purpose:** store observed + forecast weather per business per day. Feeds AI memo, scheduling suggestion, and `/weather` correlation page.
**To apply:** open Supabase SQL Editor, paste file contents, run. Then hit `POST /api/admin/weather/backfill?secret=ADMIN_SECRET` once to populate historical rows. After that, daily sync keeps it current.

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

### M003 — 2026-04-17 — Session 7 — AI Agent Tables
**Run**: 2026-04-17
**Status**: ✅ **SUCCESS** — Verified via Supabase REST probe: all 3 tables + `integrations.onboarding_email_sent` column present

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

### M006 — 2026-04-16 — Session 8 — Departments table
**Run**: ⏳ **PENDING** — Run in Supabase SQL Editor before using /departments page

```sql
-- Department definitions — one row per department per business
-- Maps department name → used as PK staff_group AND Inzii integration key
CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(org_id);
CREATE INDEX IF NOT EXISTS idx_departments_biz ON departments(business_id);
```

**After running SQL**: Go to Admin panel → expand Vero Italiano → click "Setup departments →" button
This auto-creates department records from the existing Inzii integrations.

---

### M005 — 2026-04-15 — Session 7 — Inzii POS department support
**Run**: 2026-04-15
**Status**: ✅ Complete — both steps confirmed (all 6 Inzii dept rows inserted, constraint fix working)

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

## M006 — 2026-04-15 — Session 7 — API Schema Discovery Agent
**Run**: 2026-04-15 ✅
**Status**: ✅ **SUCCESS** — Migration executed successfully

```sql
-- Table for API Schema Discovery Agent
CREATE TABLE IF NOT EXISTS api_discoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  discoveries JSONB,
  suggested_mappings JSONB,
  recommendations JSONB,
  discovered_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(integration_id)
);
ALTER TABLE api_discoveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_discoveries_select_own" ON api_discoveries
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Add last_discovery_at column to integrations table
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_discovery_at TIMESTAMPTZ;
```

**Purpose**: Stores API schema discoveries and suggested mappings for the API Schema Discovery Agent.
**Agent**: `/api/cron/api-discovery` — analyzes API endpoints and suggests mappings to CommandCenter schema.

---

## M007 — 2026-04-16 — Session 7 — Enhanced API Discovery tables
**Run**: ✅ **COMPLETE** — Executed in Supabase SQL Editor during Session 7
**Status**: ✅ COMPLETE

```sql
-- Add missing columns to integrations table
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_enhanced_discovery_at TIMESTAMPTZ;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS provider_type TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS api_endpoints_cache TEXT;

-- Create api_discoveries_enhanced table
CREATE TABLE IF NOT EXISTS api_discoveries_enhanced (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_type TEXT,
  analysis_result JSONB,
  discovered_at TIMESTAMPTZ DEFAULT now(),
  confidence_score INTEGER DEFAULT 0,
  data_type TEXT,
  unused_fields_count INTEGER DEFAULT 0,
  business_insights_count INTEGER DEFAULT 0,
  UNIQUE(integration_id)
);
ALTER TABLE api_discoveries_enhanced ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_discoveries_enhanced_select_own" ON api_discoveries_enhanced
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Create implementation_plans table
CREATE TABLE IF NOT EXISTS implementation_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  phase1_tasks JSONB,
  phase2_tasks JSONB,
  phase3_tasks JSONB,
  estimated_timeline TEXT,
  generated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(integration_id)
);
ALTER TABLE implementation_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "implementation_plans_select_own" ON implementation_plans
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));
```

---

## M008 — 2026-04-17 — Session 8 — Onboarding step + metadata columns
**Run**: 2026-04-17
**Status**: ✅ **SUCCESS** — verified via REST probe

```sql
ALTER TABLE onboarding_progress ADD COLUMN IF NOT EXISTS step TEXT;
ALTER TABLE onboarding_progress ADD COLUMN IF NOT EXISTS metadata JSONB;
```

**Why**: `/api/onboarding/setup-request` was writing to `step` and `metadata` columns that didn't exist, so every new customer's setup-form data (restaurant name, city, staff system, accounting, POS) was silently dropped. Admin panel's "Setup requests" section was always empty. After this migration, signup metadata persists and admin renders correctly.

---

## M009 — 2026-04-18 — Session 10 — Deletion requests audit table
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS**
**File**: `sql/M009-deletion-requests.sql`

Creates `public.deletion_requests` — tamper-evident audit of every GDPR Art. 17 hard delete. Written before purge, updated after. Retained indefinitely as compliance evidence. RLS enabled, no policies (service-role only).

---

## M010 — 2026-04-18 — Session 10 — Admin audit log
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS**
**File**: `sql/M010-admin-audit-log.sql`

Creates `public.admin_audit_log` — every mutation by an admin gets a row (impersonate, key edits, integration deletes, hard deletes, trial extensions, agent toggles, etc.). Three indexes: per-org, per-action, per-date. Retained 2+ years for GDPR Art. 32 evidence. Paired with new `lib/admin/audit.ts` helper and `/admin/audit` viewer page.

---

## M011 — 2026-04-18 — Session 10 — Unique constraints on upsert targets
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS** — all 7 partial unique indexes verified via `pg_indexes`
**File**: `sql/M011-unique-constraints.sql`

Closes a correctness-bug class: `lib/sync/engine.ts` upserts rely on `onConflict` keys that had no matching unique constraint, meaning duplicates silently accumulated. Each block dedupes (keeps newest by `created_at` DESC / `id` DESC) then adds a partial unique index (`WHERE business_id IS NOT NULL` pattern handles the nullable-column issue where Postgres treats NULLs as distinct).

Indexes created:
- `revenue_logs_org_biz_provider_date_unique` on (org_id, business_id, provider, revenue_date)
- `covers_business_date_unique` on (business_id, date)
- `staff_logs_pk_log_url_unique` on (pk_log_url)
- `integrations_org_biz_provider_dept_unique` on (org_id, business_id, provider, COALESCE(department, ''))
- `integrations_org_null_biz_provider_unique` on (org_id, provider, COALESCE(department, '')) WHERE business_id IS NULL
- `forecasts_org_biz_period_unique` on (org_id, business_id, period_year, period_month)
- `tracker_data_biz_period_unique` on (business_id, period_year, period_month)

Note for future migrations: `revenue_logs` and `forecasts` do not have `updated_at`; `integrations` does not have `connected_at`. Initial M011 file referenced those columns and had to be patched to use `created_at DESC NULLS LAST, id DESC` everywhere.

---

## M012 — 2026-04-18 — Session 10 — Orphan-table authoritative schema
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS** (after sync_log schema drift patch)
**File**: `sql/M012-orphan-tables.sql`

Documents every table the code reads/writes that never had a formal migration. Each `CREATE TABLE IF NOT EXISTS` is a no-op if the table already exists — safe to run repeatedly. Tables codified: `billing_events`, `invoices`, `feature_flags`, `support_notes`, `support_tickets`, `supplier_mappings`, `pk_sale_forecasts`, `financial_logs`, `api_credentials`, `api_probe_results`, `integration_health_checks`, `pos_connections`, `sync_log`, `customer_health_scores`, `ai_usage`, `ai_request_log`, `export_schedules`, `notebook_documents`.

**Patch applied during run**: `sync_log` existed in prod without the `integration_id` column, so the `CREATE INDEX … ON sync_log (integration_id, …)` statement failed with `42703`. Fix: reshaped sync_log section to `CREATE TABLE IF NOT EXISTS` with only the original five columns, then `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for the seven drifted columns (`business_id`, `integration_id`, `records_synced`, `date_from`, `date_to`, `error_msg`, `duration_ms`). Re-run after patch succeeded.

---

## Next Steps

1. **Run M007 SQL** — required for Enhanced API Discovery to work
2. **Run M003 SQL** in Supabase SQL Editor (if not already done)
3. **Deploy AI agents** to Vercel
4. **Test cron jobs** with Bearer token
5. **Monitor logs** for agent execution
6. **Update this file** with execution status

---

*Always update this file before and after running SQL in Supabase.*
