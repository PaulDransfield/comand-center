-- M045-SYNC-LOG-INDEXES.sql
-- ============================================================================
-- Indexes on sync_log to fix the 91% sequential-scan rate Supabase flagged.
--
-- sync_log has 1106 rows but every read does a full table scan because the
-- only existing index is the PK. The hot access patterns:
--
--   .eq('org_id', X).order('created_at', DESC)   -- admin sync-history tab
--   .neq('status', 'success').order('created_at')  -- admin agents tab
--                                                  -- + admin overview
--   .order('created_at', DESC)                   -- admin overview lists
--
-- Two composite indexes cover all three. Adding more would be premature
-- — sync_log stays small (~1k rows) so the marginal gain is tiny.
-- ============================================================================

BEGIN;

-- Per-customer sync history: admin v2 customer-detail Sync History sub-tab.
CREATE INDEX IF NOT EXISTS idx_sync_log_org_created
  ON sync_log (org_id, created_at DESC);

-- Failure listings: agents tab "recent failures" + admin overview's
-- "anything broken?" panel. Partial index keeps it tiny — only failed
-- runs are stored.
CREATE INDEX IF NOT EXISTS idx_sync_log_status_created
  ON sync_log (status, created_at DESC)
  WHERE status != 'success';

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'sync_log'
 ORDER BY indexname;

COMMIT;
