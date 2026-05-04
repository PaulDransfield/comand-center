-- M019 — Enable Supabase Realtime for the tables the UI subscribes to.
-- Run once in Supabase SQL Editor. Idempotent.
--
-- Supabase Realtime works via the `supabase_realtime` logical
-- publication. Tables have to be explicitly added to it to get push
-- notifications — otherwise our client subscription sits silent.
--
-- RLS still applies to Realtime events: the user only sees changes
-- on rows they're allowed to SELECT. So we rely on the RLS policies
-- we already have from M017 + M018 for isolation.

-- Idempotently add each table we want to push from.
do $pub$
declare
  tables text[] := array['fortnox_uploads', 'extraction_jobs'];
  t text;
begin
  foreach t in array tables loop
    if not exists (
      select 1 from information_schema.tables
      where table_schema='public' and table_name=t
    ) then
      raise notice '[M019] table % missing — skipping', t;
      continue;
    end if;

    -- Check whether the table is already in the publication.
    if exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      raise notice '[M019] % already in supabase_realtime publication', t;
      continue;
    end if;

    execute format('alter publication supabase_realtime add table %I', t);
    raise notice '[M019] added % to supabase_realtime', t;
  end loop;
end $pub$;

-- Verify (run manually):
-- select schemaname, tablename from pg_publication_tables
--  where pubname='supabase_realtime' and tablename in ('fortnox_uploads','extraction_jobs');
