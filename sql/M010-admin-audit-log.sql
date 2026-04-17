-- M010-admin-audit-log.sql
-- Tamper-evident record of every administrative action taken on customer data.
-- Required for GDPR Art. 32 ("ability to demonstrate"), customer DPA evidence,
-- and incident forensics.
--
-- What gets logged: impersonations, key edits, integration deletes, hard deletes,
-- trial extensions, status toggles, agent runs, discovery runs, dept setups,
-- test-connections, notes, exports. NEVER log raw API keys or passwords.

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor         text NOT NULL,                  -- 'admin', or a specific admin user id later
  action        text NOT NULL,                  -- see constants in lib/admin/audit.ts
  org_id        uuid,                           -- null for org-independent actions (e.g. master sync)
  integration_id uuid,
  target_type   text,                           -- 'org' | 'business' | 'integration' | 'user' | 'agent'
  target_id     text,
  payload       jsonb,                          -- action-specific, PII-minimised details
  ip_address    text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_org_idx    ON public.admin_audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_action_idx ON public.admin_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_date_idx   ON public.admin_audit_log (created_at DESC);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
-- No policies — default-deny. Service role (admin routes) bypasses RLS.

COMMENT ON TABLE public.admin_audit_log IS
  'Tamper-evident admin action log. Write-only from application code; never updated or deleted. Retained 2 years minimum per compliance policy.';
