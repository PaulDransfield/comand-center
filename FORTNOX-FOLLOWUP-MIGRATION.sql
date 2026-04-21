-- Fortnox follow-up migration — run once in Supabase SQL Editor.
-- Adds the industry_benchmarks table used by /api/cron/industry-benchmarks
-- and /api/overheads/benchmarks to power cross-tenant benchmark chips.
--
-- Idempotent. Safe to re-run.

create table if not exists industry_benchmarks (
  id                       uuid primary key default gen_random_uuid(),
  subcategory              text not null unique,
  label_sv                 text,
  sample_size              int  not null,
  median_kr                numeric not null,     -- median monthly spend kr
  p25_kr                   numeric not null,
  p75_kr                   numeric not null,
  median_pct_of_overhead   numeric,               -- reserved for future use
  median_pct_of_revenue    numeric,               -- reserved for future use
  generated_at             timestamptz not null default now()
);

-- Public-read RLS: benchmarks are anonymised and intentionally readable by
-- every authenticated user (they're the value prop). Writes are service-role
-- only (the weekly cron uses the admin client).
alter table industry_benchmarks enable row level security;
drop policy if exists benchmarks_read on industry_benchmarks;
create policy benchmarks_read on industry_benchmarks for select
  using (auth.role() = 'authenticated');
