-- M040-INTEGRATION-STATE-LOG.sql
-- ============================================================================
-- Sync-state centralization — audit table + canonical state vocabulary.
--
-- Why this exists: integrations.status was being written by 8+ code sites
-- with subtly different contracts. filterEligible said "probe rows in
-- status='error'", runSync re-filtered on status='connected' and rejected
-- the same rows. Aggregator paths once set status='error', then stopped
-- doing that but left wedged rows behind. Each contract drift = a sync
-- outage that took manual SQL to clear. See FIXES.md §0at.
--
-- The fix is twofold:
--   1. Single writer (lib/integrations/state.ts) that all callers go
--      through. CHECK constraint on status enforces the vocabulary at the
--      DB level so a future regression that bypasses the helper still
--      can't write garbage.
--   2. Append-only audit log of every transition for forensics. When a
--      sync error happens, the log shows the exact sequence of state
--      changes leading up to it.
--
-- New canonical statuses: connected | needs_reauth | error | retired.
-- 'retired' is new — used when a provider is permanently disabled (Inzii)
-- so eligibility.ts can skip them without DELETEing historical data.
-- ============================================================================

BEGIN;

-- ── 1. Status vocabulary CHECK constraint ─────────────────────────────────
-- Belt-and-braces validation. The state module is the primary defence;
-- this catches any direct UPDATE that slips through.
DO $$
BEGIN
  -- Drop old constraint if present (so re-runs are idempotent).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'integrations_status_canonical_chk'
  ) THEN
    ALTER TABLE integrations DROP CONSTRAINT integrations_status_canonical_chk;
  END IF;

  -- Sanity-coerce any rogue rows before adding the CHECK so the migration
  -- doesn't fail. Anything not in the canonical set falls back to 'error'
  -- which is probe-eligible and self-heals on next successful sync.
  UPDATE integrations
     SET status = 'error'
   WHERE status NOT IN ('connected', 'needs_reauth', 'error', 'retired')
      OR status IS NULL;

  ALTER TABLE integrations
    ADD CONSTRAINT integrations_status_canonical_chk
    CHECK (status IN ('connected', 'needs_reauth', 'error', 'retired'));
END $$;

-- ── 2. integration_state_log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_state_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL,                          -- denormalised for fast scoping
  business_id     UUID,                                    -- denormalised for fast scoping
  transition      TEXT NOT NULL CHECK (transition IN (
                    'created',                             -- integration row first inserted
                    'sync_started',                        -- runSync entered
                    'sync_succeeded',                      -- status flipped to connected
                    'sync_failed_retryable',               -- generic non-auth error
                    'sync_failed_auth',                    -- 401/403 → needs_reauth
                    'retired',                             -- provider permanently disabled
                    'manual_reset'                         -- admin escape hatch
                  )),
  prev_status     TEXT,
  new_status      TEXT,
  prev_last_error TEXT,
  new_last_error  TEXT,
  context         JSONB,                                   -- { records_synced, duration_ms, error_code, ... }
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: full transition history for one integration (admin debug).
CREATE INDEX IF NOT EXISTS idx_integration_state_log_integration
  ON integration_state_log (integration_id, occurred_at DESC);

-- Cross-org scan: all transitions in a window (health-check cron + admin).
CREATE INDEX IF NOT EXISTS idx_integration_state_log_org_time
  ON integration_state_log (org_id, occurred_at DESC);

-- "Find every wedge in the last hour" — fast filter on transition kind.
CREATE INDEX IF NOT EXISTS idx_integration_state_log_failures
  ON integration_state_log (transition, occurred_at DESC)
  WHERE transition IN ('sync_failed_retryable', 'sync_failed_auth');

ALTER TABLE integration_state_log ENABLE ROW LEVEL SECURITY;
-- Service-role only — this is admin/operator data. No customer-facing path
-- reads it. Customer-visible "your sync failed" messaging stays on
-- integrations.last_error.

COMMENT ON TABLE integration_state_log IS
  'Append-only audit of every integration state transition. Single source of truth for sync forensics. Service-role only.';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT 'integration_state_log' AS object, pg_relation_size('integration_state_log') AS bytes;
SELECT indexname FROM pg_indexes WHERE tablename = 'integration_state_log' ORDER BY indexname;

-- Confirm the CHECK constraint took:
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conname = 'integrations_status_canonical_chk';

-- Distribution of statuses post-coercion (should be only the canonical four):
SELECT status, COUNT(*) FROM integrations GROUP BY status ORDER BY 2 DESC;

COMMIT;
