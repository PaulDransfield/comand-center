-- M020 — AI forecast outcomes + accuracy feedback loop
-- Run once in Supabase SQL Editor. Idempotent.
--
-- Purpose: capture every AI-suggested prediction (budget revenue,
-- staff cost, etc.) alongside what actually happened, so the prompt
-- can later show the AI its own track record and correct systematic
-- bias. No ML training — purely in-context feedback via future prompts.
--
-- GDPR: this is business-level financial data, no PII. RLS scopes
-- reads to the owning org. FK cascades remove outcomes when the
-- business or org is deleted. 3-year retention enforced by the
-- ai-outcome-retention cron.

create table if not exists ai_forecast_outcomes (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id) on delete cascade,
  business_id     uuid not null references businesses(id)    on delete cascade,

  -- Which AI surface produced this prediction
  surface         text not null
    check (surface in ('budget_generate','budget_coach','budget_analyse','weekly_memo','tracker_narrative')),
  request_id      uuid,                     -- joins to ai_request_log.id when available
  model           text,

  -- Which period does the prediction cover
  period_year     int  not null,
  period_month    int,                      -- null for annual predictions
  check (period_month is null or period_month between 1 and 12),

  -- AI's suggestion (what we predicted)
  suggested_revenue     numeric,
  suggested_staff_cost  numeric,
  suggested_food_cost   numeric,
  suggested_other_cost  numeric,
  suggested_net_profit  numeric,
  suggested_margin_pct  numeric,
  -- Free-form snapshot of input context the AI was given, for diff
  -- analysis. Small JSON — no PII, no staff/customer names.
  suggested_context     jsonb not null default '{}'::jsonb,

  -- Reality (filled in by ai-accuracy-reconciler cron once month closes)
  actual_revenue        numeric,
  actual_staff_cost     numeric,
  actual_food_cost      numeric,
  actual_other_cost     numeric,
  actual_net_profit     numeric,
  actual_margin_pct     numeric,
  actuals_resolved_at   timestamptz,

  -- Computed diffs
  revenue_error_pct     numeric,
  revenue_direction     text
    check (revenue_direction in ('over','under','accurate','no_actual')),
  staff_cost_error_pct  numeric,
  margin_error_pp       numeric,            -- pp = percentage points

  -- Owner feedback (optional; wired up in Phase 4)
  owner_reaction        text
    check (owner_reaction in ('too_high','too_low','just_right','wrong_shape')),
  owner_comment         text,
  owner_feedback_at     timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Index for lookup: "outcomes for this business in the last N months"
create index if not exists ai_forecast_outcomes_biz_period_idx
  on ai_forecast_outcomes (business_id, period_year desc, period_month desc);

-- Index for the reconciler cron — find rows needing actuals
create index if not exists ai_forecast_outcomes_unresolved_idx
  on ai_forecast_outcomes (period_year, period_month)
  where actuals_resolved_at is null;

alter table ai_forecast_outcomes enable row level security;

-- Read policy: org members see their org's own outcomes only.
drop policy if exists ai_forecast_outcomes_read on ai_forecast_outcomes;
create policy ai_forecast_outcomes_read on ai_forecast_outcomes
  for select using (
    org_id in (select org_id from organisation_members where user_id = auth.uid())
  );

-- Owner feedback UPDATE policy: org members can update owner_reaction
-- / owner_comment / owner_feedback_at on their own org's rows. Nothing
-- else. All other columns are service-role only.
drop policy if exists ai_forecast_outcomes_feedback_update on ai_forecast_outcomes;
create policy ai_forecast_outcomes_feedback_update on ai_forecast_outcomes
  for update using (
    org_id in (select org_id from organisation_members where user_id = auth.uid())
  );

-- ── Retention (GDPR data minimization) ──────────────────────────────
-- Helper function the ai-outcome-retention cron calls monthly.
-- 3-year retention: derivative/audit data, shorter than bokföring's
-- 7-year requirement (which applies to the source tracker_data).
create or replace function prune_ai_forecast_outcomes()
returns int
language sql
volatile
security definer
set search_path = public
as $$
  with deleted as (
    delete from ai_forecast_outcomes
    where created_at < now() - interval '3 years'
    returning 1
  )
  select coalesce(count(*)::int, 0) from deleted;
$$;

grant execute on function prune_ai_forecast_outcomes() to service_role;

-- Verification (run manually):
-- select count(*), min(created_at), max(created_at) from ai_forecast_outcomes;
