-- M141 — integrations.metadata JSONB
--
-- 2026-06-09 — `/api/integrations/generic` started persisting per-business
-- config (e.g. Caspeco companyid, the UUID that pins a single PAT to one
-- restaurant database) under integrations.metadata. The column didn't
-- exist yet — surfaced as "column integrations.metadata does not exist"
-- on first Caspeco connect for Chicce.
--
-- Defaults to '{}' so existing rows are usable without a separate
-- backfill. JSONB chosen over TEXT because every provider stores its
-- own keys: Caspeco -> { caspeco_company_id }, future providers will
-- store their own.
--
-- Idempotent. Safe to re-run.

BEGIN;

ALTER TABLE public.integrations
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.integrations.metadata IS
  'M141 — provider-specific per-business config (e.g. caspeco_company_id UUID). Caller-set via /api/integrations/generic.';

COMMIT;
