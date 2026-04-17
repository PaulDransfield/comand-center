-- M009-deletion-requests.sql
-- GDPR Art. 17 — tamper-evident audit of every hard delete.
-- Written BEFORE rows are purged; updated AFTER to record what happened.
-- Kept forever (this is our evidence that erasure requests were honoured).

CREATE TABLE IF NOT EXISTS public.deletion_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  org_name       text NOT NULL,
  requested_by   text NOT NULL,            -- 'admin', customer user id, or automation id
  reason         text,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  status         text NOT NULL DEFAULT 'in_progress',   -- in_progress | completed | completed_with_errors | cancelled
  rows_deleted   jsonb,                    -- { table_name: count }
  users_deleted  int DEFAULT 0,
  errors         jsonb
);

CREATE INDEX IF NOT EXISTS deletion_requests_org_idx  ON public.deletion_requests (org_id);
CREATE INDEX IF NOT EXISTS deletion_requests_date_idx ON public.deletion_requests (requested_at DESC);

-- RLS: this table is admin-only. No customer-facing access.
ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;
-- No policies created — default-deny for anon/authenticated. Service role bypasses RLS.

COMMENT ON TABLE public.deletion_requests IS
  'Audit trail for GDPR Art. 17 erasure events. Written before purge, updated after. Retained indefinitely as compliance evidence.';
