-- M022-INTEGRATION-REAUTH.sql
-- Adds reauth_notified_at to `integrations` so we can dedup the
-- "please reconnect" email to one per expiration event (not one per
-- failed sync). Sync engine flips integrations.status to 'needs_reauth'
-- when a Personalkollen fetch returns 401/403; this timestamp lets
-- us send the email exactly once per transition into that state.

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS reauth_notified_at timestamptz;

-- If the status column ever had a CHECK constraint, make sure the new
-- value is allowed. We use a DO block so this is idempotent regardless
-- of whether the constraint exists under a particular name.
DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'integrations'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LIMIT 1;

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE integrations DROP CONSTRAINT %I', conname);
  END IF;
END $$;

-- Re-add a permissive check so the app-layer enum stays authoritative
-- without an overly-tight DB guard.
ALTER TABLE integrations
  ADD CONSTRAINT integrations_status_check
  CHECK (status IN ('connected','disconnected','error','needs_reauth','pending'));

-- Verify
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'integrations'
   AND column_name IN ('status','reauth_notified_at');
