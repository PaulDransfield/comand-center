-- M050-FORTNOX-BACKFILL-COLUMNS.sql
-- ============================================================================
-- 12-month Fortnox API backfill — state machine columns on `integrations`.
--
-- When a customer connects Fortnox via OAuth, the callback (in
-- app/api/integrations/fortnox/route.ts) now sets `backfill_status='pending'`
-- instead of firing the old current-month-only sync. The cron worker
-- /api/cron/fortnox-backfill-worker drains pending integrations, fetches 12
-- months of vouchers via the Phase 1 fetcher (lib/fortnox/api/vouchers.ts),
-- translates them into per-period rollups (lib/fortnox/api/voucher-to-aggregator.ts),
-- and writes canonical tracker_data rows via projectRollup.
--
-- State machine:
--   NULL or 'idle'   — no backfill needed (default for legacy rows / providers
--                      other than Fortnox)
--   'pending'        — OAuth callback or manual trigger has enqueued this
--                      integration for backfill
--   'running'        — a worker has claimed this row (atomic UPDATE) and is
--                      currently fetching/writing
--   'completed'      — backfill finished successfully; further sync runs are
--                      regular incremental crons, not backfills
--   'failed'         — backfill exhausted retries; backfill_error has details
--
-- Progress is JSONB so we can stash whatever shape is useful — months_total,
-- months_done, vouchers_fetched, current_phase, etc. — without further DDL
-- as the worker evolves.
-- ============================================================================

BEGIN;

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS backfill_status      TEXT,
  ADD COLUMN IF NOT EXISTS backfill_started_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS backfill_finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS backfill_progress    JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS backfill_error       TEXT;

-- Enum guard for the status field. NULL allowed (legacy rows / non-Fortnox).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'integrations_backfill_status_chk'
  ) THEN
    ALTER TABLE integrations
      ADD CONSTRAINT integrations_backfill_status_chk
      CHECK (backfill_status IS NULL OR backfill_status IN ('idle','pending','running','completed','failed'));
  END IF;
END $$;

-- Cheap claim query — partial index so the worker's "find next pending" scan
-- only touches the few rows that matter, not every integration in the table.
CREATE INDEX IF NOT EXISTS idx_integrations_backfill_pending
  ON integrations (provider, backfill_status, id)
  WHERE backfill_status = 'pending';

COMMENT ON COLUMN integrations.backfill_status IS
  'State machine for the 12-month Fortnox API backfill. NULL = no backfill needed (default for legacy + non-Fortnox). Drained by /api/cron/fortnox-backfill-worker.';

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'integrations'
   AND column_name LIKE 'backfill_%'
 ORDER BY column_name;

SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'integrations'
   AND indexname = 'idx_integrations_backfill_pending';

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_integrations_backfill_pending;
-- ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_backfill_status_chk;
-- ALTER TABLE integrations
--   DROP COLUMN IF EXISTS backfill_status,
--   DROP COLUMN IF EXISTS backfill_started_at,
--   DROP COLUMN IF EXISTS backfill_finished_at,
--   DROP COLUMN IF EXISTS backfill_progress,
--   DROP COLUMN IF EXISTS backfill_error;
