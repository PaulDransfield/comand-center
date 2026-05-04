-- M025 — ai_usage_notifications
--
-- Dedup table so the usage-warning emails send exactly once per
-- (org, period, level). Without this we'd spam the owner every AI call
-- once they cross a threshold.
--
-- Levels:
--   daily_80    — one email per org per calendar day
--   monthly_90  — one email per org per calendar month
--
-- Daily_50, monthly_70 are in-app only (no email, too chatty).
--
-- Idempotent. Safe to re-run.

create table if not exists ai_usage_notifications (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organisations(id) on delete cascade,
  level         text not null check (level in ('daily_80','monthly_90')),
  period_key    text not null,         -- 'YYYY-MM-DD' for daily, 'YYYY-MM' for monthly
  sent_at       timestamptz not null default now(),
  email_to      text,
  unique (org_id, level, period_key)
);

create index if not exists ai_usage_notifications_org_idx
  on ai_usage_notifications (org_id, sent_at desc);

-- RLS: read-only for org members (diagnostic only; admin views via service role).
alter table ai_usage_notifications enable row level security;

drop policy if exists ai_usage_notifications_read on ai_usage_notifications;
create policy ai_usage_notifications_read on ai_usage_notifications for select
  using (org_id in (select org_id from organisation_members where user_id = auth.uid()));

-- Writes are service-role only (lib/ai/usage.ts fires them).
