# MIGRATIONS.md — CommandCenter Database Change Log
> Created: 2026-04-11 | Session 6
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

**Why**: Personalkollen API provides OB type breakdown (OB1/OB2/OB3) and food/drink revenue split. We were not capturing this data. Added columns to store it during sync.

---

### M002 — Session 6 — AI usage tracking (RUN BEFORE SESSION 6 BUILDS)
**Run**: TBD
**Status**: ⏳ Pending

```sql
-- AI query counter per org per day
-- Used to enforce plan limits and trigger upsell prompts
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  query_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, date)
);

ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_usage_select_own" ON ai_usage_daily
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));
```

**Why**: Session 6 builds AI query limits enforcement. Need to count queries per org per day. UNIQUE(org_id, date) allows safe upsert with increment.

---

## Template for future migrations

```
### MXXX — YYYY-MM-DD — Session N — Short description
**Run**: YYYY-MM-DD
**Status**: ✅ Success / ❌ Failed / ⏳ Pending

SQL:
[paste exact SQL run]

Why: [one sentence explaining why this change was needed]
Follow-up: [any action needed after this migration]
```

---

*Never delete old entries. Never edit past entries. Only add new ones.*
*This file must be kept in sync with production schema at all times.*

### M003 — Session 6 — AI usage atomic increment RPC
**Run**: 2026-04-11
**Status**: ⏳ Pending

```sql
-- Atomic increment function for AI usage counter
-- Prevents race conditions when multiple requests hit simultaneously
CREATE OR REPLACE FUNCTION increment_ai_usage(p_org_id UUID, p_date DATE)
RETURNS void AS $$
BEGIN
  INSERT INTO ai_usage_daily (org_id, date, query_count)
  VALUES (p_org_id, p_date, 1)
  ON CONFLICT (org_id, date)
  DO UPDATE SET query_count = ai_usage_daily.query_count + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

Why: The AI route needs to atomically increment the daily query counter. Without this, concurrent requests can read the same count and both pass the limit check. This RPC handles the upsert + increment as a single DB operation.
