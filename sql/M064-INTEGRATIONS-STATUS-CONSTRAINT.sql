-- M064 — extend integrations.status CHECK constraint
--
-- Same class of bug as M061 ('paused' on backfill_status) and M063
-- (plan values). The TypeScript union for integrations.status includes:
--   'connected' | 'error' | 'warning' | 'disconnected' | 'not_connected'
--   | 'needs_reauth' | 'pending'
--
-- but the DB CHECK constraint enumerated only the original handful, so
-- the new disconnect endpoint (which sets status='disconnected') failed
-- with `integrations_status_canonical_chk` violation when first used.
--
-- 'needs_reauth' and 'pending' are also added defensively — they appear
-- in lib/sync/eligibility.ts (filterEligible probes) and in the OAuth
-- callback's mid-flight state.
--
-- Idempotent. Existing rows on legacy values stay valid.

ALTER TABLE public.integrations
  DROP CONSTRAINT IF EXISTS integrations_status_canonical_chk;

ALTER TABLE public.integrations
  ADD CONSTRAINT integrations_status_canonical_chk
  CHECK (status IS NULL OR status IN (
    'connected',
    'error',
    'warning',
    'disconnected',
    'not_connected',
    'needs_reauth',
    'pending'
  ));

-- Verify
SELECT status, COUNT(*) AS rows
FROM public.integrations
GROUP BY status
ORDER BY status NULLS LAST;
