-- M152 — flesh out support_tickets so the in-app "Contact us" form has a
-- place to record the message (not just fire an email). The M012 stub only
-- had id/org_id/title/status/priority/timestamps.
--
-- Written + read server-side only (service_role); RLS stays enabled with no
-- policy = deny-all for anon/authenticated, which is correct here.
-- Idempotent.

ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS category      text;   -- 'support' | 'security' | 'billing'
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS message       text;
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS contact_name  text;
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS business_id   uuid;
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS user_id       uuid;
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS page          text;
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS email_status  text;   -- 'sent' | 'failed' | null
