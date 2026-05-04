-- M018 — Close RLS gaps + fix multi-org visibility (DEFENSIVE VERSION)
-- Run once in Supabase SQL Editor. Idempotent. Safe to re-run.
--
-- Context: audit on 2026-04-21 found five tables with RLS disabled
-- (auth_events, bankid_sessions, email_log, gdpr_consents,
-- onboarding_progress) plus a current_org_id() function that only
-- returned the first org a user belonged to.
--
-- This version introspects each table's columns before attaching a
-- policy — safer than assuming a specific shape because different
-- migrations at different times may have used user_id, org_id, or
-- both as the scoping column.

-- ── 1. Helper: enable RLS + attach the right policy per table ──────
-- For each target table we:
--   • Skip if the table does not exist.
--   • Enable RLS.
--   • Drop any prior policy created by this migration (idempotent).
--   • Attach a policy scoped to whichever of {user_id, org_id} is
--     present. If both, user_id wins for user-scoped tables
--     (auth_events, bankid_sessions); otherwise org_id scoping.

do $mig$
declare
  r               record;
  t               text;
  has_user_id     boolean;
  has_org_id      boolean;
  policy_name     text;
  target_tables   text[] := array[
    'auth_events',
    'bankid_sessions',
    'email_log',
    'gdpr_consents',
    'onboarding_progress'
  ];
begin
  foreach t in array target_tables loop
    -- Skip if missing
    if not exists (
      select 1 from information_schema.tables
      where table_schema='public' and table_name=t
    ) then
      raise notice '[M018] table %.% missing — skipping', 'public', t;
      continue;
    end if;

    select exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name=t and column_name='user_id'
    ) into has_user_id;

    select exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name=t and column_name='org_id'
    ) into has_org_id;

    execute format('alter table %I enable row level security', t);
    policy_name := t || '_rls_read';
    execute format('drop policy if exists %I on %I', policy_name, t);

    -- auth_events and bankid_sessions are user-level data — prefer user_id.
    -- All others are org-level — prefer org_id.
    if t in ('auth_events','bankid_sessions') and has_user_id then
      execute format(
        'create policy %I on %I for select using (user_id = auth.uid())',
        policy_name, t
      );
      raise notice '[M018] policy user_id on %', t;
    elsif has_org_id then
      execute format(
        'create policy %I on %I for select using (org_id in (select org_id from organisation_members where user_id = auth.uid()))',
        policy_name, t
      );
      raise notice '[M018] policy org_id on %', t;
    elsif has_user_id then
      execute format(
        'create policy %I on %I for select using (user_id = auth.uid())',
        policy_name, t
      );
      raise notice '[M018] policy user_id on % (fallback)', t;
    else
      raise notice '[M018] %: no user_id or org_id column — RLS enabled with NO select policy (service-role only).', t;
    end if;
  end loop;
end $mig$;

-- ── 2. Multi-org visibility function ──────────────────────────────
-- Replace single-org current_org_id() with array-returning function.
-- Policies using current_org_id() keep working (backwards-compat alias
-- returns the first org). New policies should use ANY(current_user_org_ids()).

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
-- Array-based rewrite for tables that previously delegated to
-- current_org_id(). Only runs if the table exists.

do $mig$
declare
  upd_tables text[] := array[
    'tracker_data',
    'tracker_line_items',
    'notebooks',
    'documents'
  ];
  t text;
  policy_name text;
begin
  foreach t in array upd_tables loop
    if not exists (
      select 1 from information_schema.tables
      where table_schema='public' and table_name=t
    ) then
      continue;
    end if;

    execute format('alter table %I enable row level security', t);
    -- Drop any existing read policy names this migration may have used
    for policy_name in
      select policyname from pg_policies
      where schemaname='public' and tablename=t and policyname like t || '_read'
    loop
      execute format('drop policy if exists %I on %I', policy_name, t);
    end loop;

    execute format(
      'create policy %I on %I for select using (org_id = any(current_user_org_ids()))',
      t || '_read', t
    );
  end loop;
end $mig$;

-- ── 4. Stripe event dedup table ───────────────────────────────────
-- Every Stripe webhook event gets its id inserted here inside the same
-- write as the domain mutation. A replay hits the unique PK constraint
-- and the webhook handler acknowledges with 200 without repeating.
create table if not exists stripe_processed_events (
  event_id     text primary key,
  event_type   text,
  processed_at timestamptz not null default now()
);
alter table stripe_processed_events enable row level security;
-- No user-facing policy — service role only.

-- ── 5. Per-org rate limit table ──────────────────────────────────
-- Persists rate-limit counters across Vercel cold starts. Used by
-- lib/middleware/org-rate-limit.ts for Stripe checkout and other
-- cost-sensitive paths where in-memory limits would be bypassed.
create table if not exists org_rate_limits (
  org_id       uuid not null references organisations(id) on delete cascade,
  bucket       text not null,
  window_start timestamptz not null,
  count        int  not null default 1,
  primary key (org_id, bucket, window_start)
);
create index if not exists org_rate_limits_lookup_idx
  on org_rate_limits (org_id, bucket, window_start desc);
alter table org_rate_limits enable row level security;
-- No user-facing policy — service role only.

-- ── 6. Verification (run manually) ────────────────────────────────
-- Confirm RLS is now on for all 5 target tables:
-- select tablename, rowsecurity from pg_tables
--   where schemaname='public'
--     and tablename in ('auth_events','bankid_sessions','email_log','gdpr_consents','onboarding_progress')
--   order by tablename;
-- Expected: rowsecurity = true for every row returned.
