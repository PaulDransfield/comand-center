-- Fortnox extraction job queue — run once in the Supabase SQL Editor.
-- Creates the extraction_jobs table that powers the queue-based
-- architecture for Fortnox PDF extraction: dispatcher writes a pending
-- job, workers claim atomically, retries are automatic, stale jobs
-- get reset by a sweeper cron.
--
-- Idempotent. Safe to re-run.

create table if not exists extraction_jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations(id) on delete cascade,
  business_id     uuid not null references businesses(id)    on delete cascade,
  upload_id       uuid not null unique references fortnox_uploads(id) on delete cascade,
  status          text not null default 'pending'
    check (status in ('pending','processing','completed','failed','dead')),
  attempts        int  not null default 0,
  max_attempts    int  not null default 3,
  scheduled_for   timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  error_message   text,
  progress        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Dispatch index — workers query by (status, scheduled_for) to pull
-- the next due job. Partial index keeps it tiny since most rows over
-- time will be 'completed' or 'dead'.
create index if not exists extraction_jobs_dispatch_idx
  on extraction_jobs (scheduled_for, status)
  where status = 'pending';

-- Stale-reset index — sweeper queries jobs stuck in 'processing' for
-- longer than the soft timeout to recover from crashed workers.
create index if not exists extraction_jobs_stuck_idx
  on extraction_jobs (started_at)
  where status = 'processing';

-- Progress updated_at index — UI subscriptions/polls stay cheap.
create index if not exists extraction_jobs_upload_idx
  on extraction_jobs (upload_id);

alter table extraction_jobs enable row level security;

-- Read policy — members of the owning org can read their jobs. Writes
-- are service-role only (workers run as admin client).
drop policy if exists extraction_jobs_read on extraction_jobs;
create policy extraction_jobs_read on extraction_jobs for select
  using (org_id in (select org_id from organisation_members where user_id = auth.uid()));

-- ── RPC: atomic claim of the next pending job ──────────────────────────
-- FOR UPDATE SKIP LOCKED is the standard Postgres pattern for safe
-- concurrent queue consumers — two workers hitting this at once each
-- get a different job (or no job), never the same one. Increments the
-- attempts counter as part of the same transaction.
create or replace function claim_next_extraction_job()
returns setof extraction_jobs
language sql
volatile
security definer
set search_path = public
as $$
  update extraction_jobs
  set status        = 'processing',
      started_at    = now(),
      attempts      = attempts + 1,
      updated_at    = now()
  where id = (
    select id from extraction_jobs
    where status = 'pending' and scheduled_for <= now()
    order by scheduled_for asc
    for update skip locked
    limit 1
  )
  returning *;
$$;

-- ── RPC: reset stale 'processing' jobs back to 'pending' ───────────────
-- Called by the sweeper cron. Any job that's been 'processing' for
-- more than 10 minutes is assumed to have crashed (Vercel killed the
-- function, OOM, etc.). Reset without decrementing attempts — the
-- attempt counted even though it failed to complete.
create or replace function reset_stale_extraction_jobs()
returns int
language sql
volatile
security definer
set search_path = public
as $$
  with updated as (
    update extraction_jobs
    set status        = 'pending',
        started_at    = null,
        updated_at    = now(),
        error_message = coalesce(nullif(error_message, ''), '') || '[reset-stale] '
    where status = 'processing'
      and started_at < now() - interval '10 minutes'
    returning 1
  )
  select coalesce(count(*)::int, 0) from updated;
$$;

-- ── RPC: list pending jobs ready to fire ───────────────────────────────
-- Sweeper uses this to decide which jobs to poke via worker HTTP call.
-- Returns a small slice at a time so a big backlog doesn't take the
-- sweeper function past its timeout.
create or replace function list_ready_extraction_jobs(max_jobs int default 10)
returns setof extraction_jobs
language sql
stable
security definer
set search_path = public
as $$
  select * from extraction_jobs
  where status = 'pending' and scheduled_for <= now()
  order by scheduled_for asc
  limit max_jobs;
$$;

grant execute on function claim_next_extraction_job()       to service_role;
grant execute on function reset_stale_extraction_jobs()     to service_role;
grant execute on function list_ready_extraction_jobs(int)   to service_role;
