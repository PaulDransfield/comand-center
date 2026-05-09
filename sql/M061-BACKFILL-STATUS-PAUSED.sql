-- M061 — add 'paused' to integrations.backfill_status CHECK constraint
--
-- M060 introduced resumable backfills which use a new status value 'paused'
-- (worker has saved state and exited cleanly before maxDuration; next worker
-- invocation can resume). The original M050 CHECK constraint didn't include
-- 'paused', so any UPDATE setting the new value fails:
--
--   ERROR: new row for relation "integrations" violates check constraint
--   "integrations_backfill_status_chk"
--
-- This migration drops + re-creates the constraint with the expanded set.
-- Idempotent.

ALTER TABLE public.integrations
  DROP CONSTRAINT IF EXISTS integrations_backfill_status_chk;

ALTER TABLE public.integrations
  ADD CONSTRAINT integrations_backfill_status_chk
  CHECK (backfill_status IS NULL OR backfill_status IN (
    'idle',
    'pending',
    'running',
    'paused',
    'completed',
    'failed'
  ));

-- Verification
SELECT DISTINCT backfill_status, COUNT(*) AS rows
FROM public.integrations
GROUP BY backfill_status
ORDER BY backfill_status NULLS LAST;
