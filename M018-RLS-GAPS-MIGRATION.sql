-- M018 — Close RLS gaps + fix multi-org visibility
-- Run once in Supabase SQL Editor. Idempotent. Safe to re-run.
--
-- Context: audit on 2026-04-21 found five org-scoped tables with
-- row-level security disabled (code-side .eq('org_id', auth.orgId)
-- filters were the only barrier), plus a current_org_id() function
-- that returned LIMIT 1 so users belonging to multiple orgs saw
-- data from only one of them non-deterministically.
--
-- This migration:
--   1. Enables RLS on 5 missing tables and adds SELECT/WRITE policies
--   2. Replaces current_org_id() with current_user_org_ids() returning
--      the full array of orgs a user belongs to, via ANY() in policies
--   3. Updates every policy that relied on the old function

-- ── 1. RLS on previously-exposed tables ────────────────────────────
-- Five tables identified in the 2026-04-21 audit. Each gets:
--   • RLS enabled
--   • SELECT policy scoped to the caller's orgs (or their own user_id
--     for user-level tables like auth_events, bankid_sessions)
--   • Service-role-only writes (no user policy → all writes go via
--     createAdminClient / security-definer RPCs)

-- auth_events — one row per auth attempt / session event
alter table if exists auth_events enable row level security;
drop policy if exists auth_events_own_read on auth_events;
create policy auth_events_own_read on auth_events
  for select using (user_id = auth.uid());

-- bankid_sessions — BankID OAuth state tokens
alter table if exists bankid_sessions enable row level security;
drop policy if exists bankid_sessions_own_read on bankid_sessions;
create policy bankid_sessions_own_read on bankid_sessions
  for select using (user_id = auth.uid());

-- email_log — transactional emails sent per org
alter table if exists email_log enable row level security;
drop policy if exists email_log_org_read on email_log;
create policy email_log_org_read on email_log
  for select using (
    org_id in (select org_id from organisation_members where user_id = auth.uid())
  );

-- gdpr_consents — consent records per user per org
alter table if exists gdpr_consents enable row level security;
drop policy if exists gdpr_consents_own_read on gdpr_consents;
create policy gdpr_consents_own_read on gdpr_consents
  for select using (
    user_id = auth.uid() or
    org_id in (select org_id from organisation_members where user_id = auth.uid())
  );

-- onboarding_progress — setup state per org
alter table if exists onboarding_progress enable row level security;
drop policy if exists onboarding_progress_org_read on onboarding_progress;
create policy onboarding_progress_org_read on onboarding_progress
  for select using (
    org_id in (select org_id from organisation_members where user_id = auth.uid())
  );
drop policy if exists onboarding_progress_org_upd on onboarding_progress;
create policy onboarding_progress_org_upd on onboarding_progress
  for update using (
    org_id in (select org_id from organisation_members where user_id = auth.uid())
  );

-- ── 2. Multi-org visibility function ──────────────────────────────
-- Old current_org_id() returned a single org (LIMIT 1) which broke
-- visibility for users who belong to multiple orgs (consultants,
-- group owners). Replace with an array-returning function and update
-- callers to use ANY().

create or replace function current_user_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(org_id), '{}'::uuid[])
  from organisation_members
  where user_id = auth.uid();
$$;

grant execute on function current_user_org_ids() to authenticated;

-- Keep current_org_id() as a backwards-compat alias for one release —
-- policies that use it will still see the first org, but new policies
-- should use current_user_org_ids().
create or replace function current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select (current_user_org_ids())[1];
$$;

-- ── 3. Update policies that used the single-org function ──────────
-- Any table that was using current_org_id() in its policy now switches
-- to current_user_org_ids() so multi-org users see all their data.

-- tracker_data
do $$ begin
  if exists (select 1 from pg_policies where tablename='tracker_data' and policyname='tracker_data_read') then
    drop policy tracker_data_read on tracker_data;
  end if;
end $$;
create policy tracker_data_read on tracker_data for select
  using (org_id = any(current_user_org_ids()));

-- tracker_line_items
do $$ begin
  if exists (select 1 from pg_policies where tablename='tracker_line_items' and policyname='tracker_line_items_read') then
    drop policy tracker_line_items_read on tracker_line_items;
  end if;
end $$;
create policy tracker_line_items_read on tracker_line_items for select
  using (org_id = any(current_user_org_ids()));

-- notebooks
do $$ begin
  if exists (select 1 from pg_policies where tablename='notebooks' and policyname='notebooks_read') then
    drop policy notebooks_read on notebooks;
  end if;
end $$;
alter table if exists notebooks enable row level security;
create policy notebooks_read on notebooks for select
  using (org_id = any(current_user_org_ids()));

-- documents
do $$ begin
  if exists (select 1 from pg_policies where tablename='documents' and policyname='documents_read') then
    drop policy documents_read on documents;
  end if;
end $$;
alter table if exists documents enable row level security;
create policy documents_read on documents for select
  using (org_id = any(current_user_org_ids()));

-- ── 4. Stripe event dedup table ───────────────────────────────────
-- Every Stripe webhook event gets its id inserted here inside the same
-- write as the domain mutation. A replay tries to insert the same id
-- and hits the unique constraint → webhook handler acknowledges with
-- 200 without repeating the work.
create table if not exists stripe_processed_events (
  event_id     text primary key,
  event_type   text,
  processed_at timestamptz not null default now()
);
-- No RLS policy: admin client only. The table has no user-scoped data.
alter table stripe_processed_events enable row level security;

-- Optional retention: events older than 90 days have served their
-- purpose and can be trimmed. A cron calling this weekly keeps the
-- table small. Not part of this migration — add as a cron if needed.

-- ── 5. Per-org rate limit table (for Stripe checkout + AI spend) ─
-- Minimal rate-limit persistence so rate limits survive serverless
-- cold starts (the current lib/middleware/rate-limit.ts is in-memory
-- and resets on every deploy / new instance). The app-level helper
-- wraps reads/writes here.
create table if not exists org_rate_limits (
  org_id     uuid not null references organisations(id) on delete cascade,
  bucket     text not null,           -- e.g. 'stripe_checkout', 'ai_ask'
  window_start timestamptz not null,
  count      int not null default 1,
  primary key (org_id, bucket, window_start)
);
create index if not exists org_rate_limits_lookup_idx
  on org_rate_limits (org_id, bucket, window_start desc);

alter table org_rate_limits enable row level security;
-- No user-facing read/write policy — service role only.

-- ── 6. Verification queries (run manually, not part of migration) ──
-- Confirm no org-scoped tables slipped through:
-- select tablename, rowsecurity from pg_tables where schemaname='public'
--   and tablename in ('auth_events','bankid_sessions','email_log','gdpr_consents','onboarding_progress')
-- order by tablename;
-- Expect: rowsecurity=true for all five rows.
