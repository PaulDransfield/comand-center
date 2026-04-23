-- M026 — schedule_acceptances
--
-- When the operator clicks "Accept" on an AI-suggested schedule day (or
-- "Apply all"), we persist the decision here. Drives:
--   · "Accepted ✓" survives reload + navigation
--   · Hero recomputation (WITH N OF M APPLIED)
--   · Downstream learning loop via ai_forecast_outcomes — did the accepted
--     cut actually match the realised labour cost?
--
-- One row per (business, date). Re-accepting the same day (e.g. if the AI
-- recomputed) UPDATES rather than inserts.

create table if not exists schedule_acceptances (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations(id) on delete cascade,
  business_id      uuid not null references businesses(id) on delete cascade,
  date             date not null,
  -- Snapshot of the decision at accept time. Lets us reason about drift
  -- when the AI re-suggests a different number later.
  ai_hours         numeric(6,1) not null,
  ai_cost_kr       numeric(10,2) not null,
  current_hours    numeric(6,1) not null,   -- what the operator's PK schedule said when they accepted
  current_cost_kr  numeric(10,2) not null,
  est_revenue_kr   numeric(12,2),           -- pattern avg at accept time (for labour %)
  -- Bulk accepts note the batch id so "Undo all" can revert just the batch.
  batch_id         uuid,
  decided_by       uuid references auth.users(id) on delete set null,
  decided_at       timestamptz not null default now(),
  unique (business_id, date)
);

create index if not exists schedule_acceptances_biz_date_idx
  on schedule_acceptances (business_id, date);
create index if not exists schedule_acceptances_batch_idx
  on schedule_acceptances (batch_id) where batch_id is not null;

alter table schedule_acceptances enable row level security;

drop policy if exists schedule_acceptances_read on schedule_acceptances;
create policy schedule_acceptances_read on schedule_acceptances for select
  using (org_id in (select org_id from organisation_members where user_id = auth.uid()));

drop policy if exists schedule_acceptances_write on schedule_acceptances;
create policy schedule_acceptances_write on schedule_acceptances for all
  using (org_id in (select org_id from organisation_members where user_id = auth.uid()))
  with check (org_id in (select org_id from organisation_members where user_id = auth.uid()));
