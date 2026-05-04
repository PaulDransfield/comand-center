-- M024-PK-SYNC-CURSORS.sql
-- Adds a per-integration JSONB bag for Personalkollen sync cursors so
-- master-sync can do incremental fetches (pass ?sync_cursor=<last>) instead
-- of refetching the whole date range every run. PK recommends this for any
-- high-volume sync; it roughly halves both their API calls and our Vercel
-- function time on repeat syncs.
--
-- Shape:
--   { "logged-times": "2026-04-23T09:33:15.123+00:00",
--     "sales":        "2026-04-23T09:33:15.456+00:00" }
--
-- work-periods is intentionally NOT cursor-driven — the scheduling AI page
-- needs a full snapshot of next week, not "changes since last run".

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS pk_sync_cursors jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Verify
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'integrations'
   AND column_name = 'pk_sync_cursors';
