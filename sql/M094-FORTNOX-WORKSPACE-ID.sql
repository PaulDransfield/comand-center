-- M094 — integrations.fortnox_workspace_id
--
-- Fortnox web app deep-links require a per-tenant workspace UUID:
--   https://apps2.fortnox.se/app/{workspace_id}/lf/supplierinvoice/{GivenNumber}
--
-- No public API exposes this — owner has to paste their Fortnox URL
-- once and we extract the 32-hex segment. Stored on the integration
-- row so each business has its own value.
--
-- Idempotent. Safe to re-run.

ALTER TABLE public.integrations
  ADD COLUMN IF NOT EXISTS fortnox_workspace_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integrations_fortnox_workspace_id_chk'
  ) THEN
    ALTER TABLE public.integrations
      ADD CONSTRAINT integrations_fortnox_workspace_id_chk
      CHECK (
        fortnox_workspace_id IS NULL
        OR fortnox_workspace_id ~ '^[a-f0-9]{32}$'  -- exactly 32 lowercase hex
      );
  END IF;
END $$;

COMMENT ON COLUMN public.integrations.fortnox_workspace_id IS
  '32-hex workspace UUID for Fortnox web app deep links. Extracted from URL: https://apps2.fortnox.se/app/{this}/... Capture once per business via /integrations.';
