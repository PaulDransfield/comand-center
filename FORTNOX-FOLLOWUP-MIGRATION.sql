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

-- Reconciliation findings — invoice ↔ Fortnox line-item mismatches.
create table if not exists reconciliation_findings (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organisations(id) on delete cascade,
  business_id  uuid not null references businesses(id)    on delete cascade,
  kind         text not null
    check (kind in ('invoice_not_in_fortnox','line_without_invoice','amount_mismatch')),
  tone         text not null default 'warning'
    check (tone in ('good','warning','bad')),
  entity       text not null,
  message      text not null,
  evidence     jsonb,
  generated_at timestamptz not null default now(),
  dismissed_at timestamptz
);
create index if not exists reconciliation_active_idx
  on reconciliation_findings (business_id, generated_at desc)
  where dismissed_at is null;

-- Expand fortnox_uploads.doc_type to accept multi-month Resultatrapports.
-- Fortnox commonly exports a single PDF with 12 monthly columns — we now
-- split those into per-month tracker_data rows, so the upload-level
-- doc_type gets a new value.
alter table fortnox_uploads drop constraint if exists fortnox_uploads_doc_type_check;
alter table fortnox_uploads
  add constraint fortnox_uploads_doc_type_check
  check (doc_type in ('pnl_monthly','pnl_annual','pnl_multi_month','invoice','sales','vat'));

alter table reconciliation_findings enable row level security;
drop policy if exists reconciliation_read on reconciliation_findings;
drop policy if exists reconciliation_upd  on reconciliation_findings;
create policy reconciliation_read on reconciliation_findings for select
  using (org_id in (select org_id from organisation_members where user_id = auth.uid()));
create policy reconciliation_upd on reconciliation_findings for update
  using (org_id in (select org_id from organisation_members where user_id = auth.uid()));
