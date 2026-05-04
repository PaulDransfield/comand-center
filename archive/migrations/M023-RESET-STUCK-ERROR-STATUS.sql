-- M023-RESET-STUCK-ERROR-STATUS.sql
-- One-off cleanup: integrations that synced successfully recently but still
-- show status='error' because engine.ts was only updating last_sync_at +
-- last_error on success, not status. The fix in commit 0be3eef+ resets status
-- on every successful sync going forward — this backfill unsticks anything
-- that was caught in the old broken state.
--
-- Criteria: synced in the last 48h AND no pending error message.
-- Deliberately cautious — won't flip genuinely broken integrations back.

UPDATE integrations
   SET status = 'connected',
       reauth_notified_at = NULL
 WHERE status IN ('error','needs_reauth')
   AND last_sync_at IS NOT NULL
   AND last_sync_at >= NOW() - INTERVAL '48 hours'
   AND (last_error IS NULL OR last_error = '');

-- Verify how many rows got flipped + confirm none left stuck
SELECT status, COUNT(*) AS n
  FROM integrations
 GROUP BY status
 ORDER BY status;
