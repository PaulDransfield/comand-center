-- M096 — Fortnox refresh-token race lock (cross-process serialisation)
--
-- Problem (incident 2026-05-24): when N concurrent Lambda invocations
-- all read the same refresh_token from credentials_enc and post it to
-- Fortnox's token endpoint simultaneously, Fortnox honours the FIRST
-- request (rotates the refresh_token, returns a fresh pair) and rejects
-- every subsequent one with `invalid_grant — Invalid refresh token`.
-- Our refresh helper then flips `status='needs_reauth'`, the integration
-- dies, every Fortnox-touching surface 404s/401s until the owner re-OAuths.
--
-- Pre-fix this was rare because we had ~5 Fortnox calls per minute.
-- Post-inventory-pipeline we have ~50/min (page loads fire 9+ concurrent
-- endpoints; backfills hammer in the background). The race window now
-- hits multiple times per hour.
--
-- This migration adds a per-integration lock so only ONE process can be
-- inside the refresh codepath at a time. Other processes that arrive
-- during a refresh wait for the holder to finish, then re-read the row
-- (now containing the refreshed tokens) and use those instead.
--
-- Why a table + RPC rather than pg_advisory_lock:
--   - Supabase JS goes through PgBouncer in transaction mode, which
--     re-issues a session per query — advisory locks scoped to a
--     session don't survive across two supabase-js calls.
--   - An RPC keeps acquire+release in a single session, but then
--     handing the access_token back to JS means the RPC has to do the
--     whole refresh internally (Fortnox HTTP call from inside a Postgres
--     function via pg_net) — adds infrastructure surface for marginal gain.
--   - Table-based lock is dead simple, sweeps itself for stale holders,
--     works through PgBouncer, observable in the DB.

BEGIN;

CREATE TABLE IF NOT EXISTS fortnox_refresh_locks (
  integration_id  UUID PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acquired_by     TEXT             -- best-effort process identifier for debugging
);

COMMENT ON TABLE fortnox_refresh_locks IS
  'M096: serialises Fortnox refresh-token rotations per integration. Rows are short-lived (<30s); auto-swept by acquire_fortnox_refresh_lock when older than 30s.';

-- ───────────────────────────────────────────────────────────────────
-- acquire_fortnox_refresh_lock(uuid, text) → boolean
--   Returns TRUE if THIS call inserted a fresh lock row → caller has
--   the lock and must do the refresh, then call release_*.
--   Returns FALSE if another process is currently holding the lock
--   (and the lock is not yet stale) → caller should wait + re-read.
--
-- Stale-sweep: rows older than 30 seconds are deleted before the insert
-- attempt. 30s is comfortably above any realistic Fortnox refresh
-- round-trip (typically 200-500ms) but small enough that a crashed
-- holder doesn't strand callers for long.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION acquire_fortnox_refresh_lock(
  p_integration_id UUID,
  p_owner          TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rows_inserted INT;
BEGIN
  -- Sweep stale lock for this integration (if any). Single atomic
  -- statement; if no stale row exists this is a no-op.
  DELETE FROM fortnox_refresh_locks
   WHERE integration_id = p_integration_id
     AND acquired_at < NOW() - INTERVAL '30 seconds';

  INSERT INTO fortnox_refresh_locks (integration_id, acquired_by)
  VALUES (p_integration_id, p_owner)
  ON CONFLICT (integration_id) DO NOTHING;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  RETURN rows_inserted > 0;
END;
$$;

-- ───────────────────────────────────────────────────────────────────
-- release_fortnox_refresh_lock(uuid) → void
--   Caller MUST call this in a `finally`-equivalent path. Idempotent
--   (DELETE of a non-existent row is a no-op).
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION release_fortnox_refresh_lock(
  p_integration_id UUID
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM fortnox_refresh_locks WHERE integration_id = p_integration_id;
$$;

GRANT EXECUTE ON FUNCTION acquire_fortnox_refresh_lock(UUID, TEXT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION release_fortnox_refresh_lock(UUID)       TO service_role, authenticated;

COMMIT;
