-- VALIDATION-RUNBOOK.sql — safety checks for CommandCenter.
--
-- Run the whole file in Supabase SQL Editor any time you want to
-- confirm the architecture invariants still hold. No mutations; all
-- queries are read-only. Expected results documented inline.
--
-- Last full run: TO DO — record here after each pass.

-- =====================================================================
-- §1 — Tenant isolation: RLS is ON for every org-scoped table
-- =====================================================================
-- Expected: every row returned should show rowsecurity=true.
-- If any row shows false, add it to M018 or equivalent migration.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    -- Core tenancy tables
    'organisations','organisation_members','businesses','integrations',
    -- Data tables
    'staff_logs','revenue_logs','tracker_data','tracker_line_items',
    'forecasts','alerts','covers','financial_logs','daily_metrics',
    'monthly_metrics','dept_metrics','anomaly_alerts','pk_sale_forecasts',
    -- AI / audit
    'ai_request_log','ai_usage_daily','ai_usage_daily_by_user',
    'briefings','memo_feedback','cost_insights',
    -- Fortnox
    'fortnox_uploads','extraction_jobs','reconciliation_findings',
    'industry_benchmarks',
    -- Billing
    'billing_events','stripe_processed_events','org_rate_limits',
    -- Security-sensitive
    'auth_events','bankid_sessions','email_log','gdpr_consents',
    'onboarding_progress','admin_log','admin_actions',
    'api_discoveries','api_discoveries_enhanced','implementation_plans',
    'weather_daily','sync_log','notebooks','documents'
  )
order by rowsecurity, tablename;

-- =====================================================================
-- §2 — No admin route reads org_id from the body without verification
-- =====================================================================
-- This is a code-audit check, not a SQL check. Grep the codebase:
--   grep -rn "await req.json()" app/api/admin | grep -v "requireAdmin\|checkAdminSecret.*orgId"
-- Expected: every match should be followed by a requireAdmin() call
-- with the same orgId before any DB mutation.

-- =====================================================================
-- §3 — Stripe webhook dedup table exists and is growing
-- =====================================================================
-- Expected: stripe_processed_events has ≥1 row if you've had ANY
-- subscription activity. Empty table after a known Stripe event means
-- the webhook handler or dedup logic is broken.
select count(*) as events_processed,
       max(processed_at) as latest_event
from stripe_processed_events;

-- Sanity check: no duplicate event_ids (PK enforces this, but surface any)
select event_id, count(*) as dupes
from stripe_processed_events
group by event_id
having count(*) > 1;
-- Expected: zero rows.

-- =====================================================================
-- §4 — Extraction queue health
-- =====================================================================
-- Expected:
--   dead       = 0  (any >0 means a PDF failed all 3 retries — investigate)
--   stale      = 0  (>10 min in 'processing' = sweeper hasn't reset yet or worker hung)
--   processing ≤ 2 (only if an extraction is actively running)
select status,
       count(*)                                       as n,
       max(now() - started_at)                         as oldest_processing,
       max(now() - completed_at)                       as latest_finish
from extraction_jobs
group by status
order by status;

-- =====================================================================
-- §5 — AI cost burn
-- =====================================================================
-- Expected: daily spend stays under the plan ceiling. Trial: 30 kr/mo;
-- Starter: 60 kr/mo; Pro: 150 kr/mo; Enterprise: 1500 kr/mo.
select date_trunc('day', created_at)::date as day,
       count(*)                             as calls,
       sum(input_tokens)                    as in_tokens,
       sum(output_tokens)                   as out_tokens,
       round(sum(input_tokens * 1e-6 + output_tokens * 5e-6) * 11, 2) as cost_sek
from ai_request_log
where created_at >= now() - interval '14 days'
group by 1
order by 1 desc;

-- =====================================================================
-- §6 — Sync health by integration
-- =====================================================================
-- Expected: last_sync_at within the last 24h for every connected
-- integration. Rows with last_error populated warrant a look.
select i.provider,
       o.name                         as org,
       b.name                         as business,
       i.last_sync_at,
       now() - i.last_sync_at         as age,
       i.last_error
from integrations i
left join organisations o on o.id = i.org_id
left join businesses b    on b.id = i.business_id
where i.status = 'connected'
order by i.last_sync_at nulls first;

-- =====================================================================
-- §7 — Fortnox OAuth token expiry horizon
-- =====================================================================
-- Expected: every Fortnox integration has expires_at > now() +
-- 5 minutes. The sync engine auto-refreshes below that threshold, but
-- if a refresh fails the integration will be stuck — surface it early.
select org_id,
       business_id,
       -- expires_at is stored inside credentials_enc JSON; decode is
       -- server-side only. This query just confirms the row exists.
       id,
       last_sync_at,
       last_error
from integrations
where provider = 'fortnox' and status = 'connected';

-- =====================================================================
-- §8 — Rate-limit counters — nothing hot right now?
-- =====================================================================
-- Expected: no org has hit the checkout limits in the last 24h.
-- Any row here with count >= max is worth investigating (compromised
-- session or runaway client script).
select org_id, bucket, window_start, count
from org_rate_limits
where window_start >= now() - interval '24 hours'
  and count >= 4
order by window_start desc
limit 20;

-- =====================================================================
-- §9 — Dead jobs & stuck work — anything needing manual intervention?
-- =====================================================================
select 'extraction_jobs.dead'    as concern, count(*) as n from extraction_jobs where status='dead'
union all
select 'integrations.with_error', count(*)           from integrations where last_error is not null
union all
select 'uploads.stuck_extracting', count(*)          from fortnox_uploads where status='extracting' and created_at < now() - interval '10 minutes';
-- Expected: ideally all zeros. Nonzero = look at /admin/health for details.

-- =====================================================================
-- §10 — Fortnox→monthly_metrics flow-through (added 2026-04-22)
-- =====================================================================
-- For every business with Fortnox P&L data in tracker_data, verify
-- monthly_metrics has the corresponding rows with rev_source in
-- ('pos','fortnox') — NOT 'none'. If 'none' appears on a Fortnox
-- month it means the aggregator never merged revenue for that month.
-- Fix: POST /api/admin/reaggregate { business_id, from_year, to_year }.
with fortnox_months as (
  select business_id, period_year as y, period_month as m
  from tracker_data
  where source = 'fortnox_pdf' and period_month between 1 and 12
)
select fm.business_id,
       fm.y                                as year,
       fm.m                                as month,
       coalesce(mm.rev_source, 'MISSING_ROW') as rev_source,
       coalesce(mm.revenue, 0)              as revenue
from fortnox_months fm
left join monthly_metrics mm
  on mm.business_id = fm.business_id
 and mm.year        = fm.y
 and mm.month       = fm.m
where coalesce(mm.rev_source, '') in ('none', 'MISSING_ROW', '')
   or coalesce(mm.revenue, 0) = 0
order by fm.business_id, fm.y, fm.m;
-- Expected: zero rows. Any row means a Fortnox month didn't make it
-- into monthly_metrics correctly.
