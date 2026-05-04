-- M027-AGGREGATION-LOCK.sql
-- Per-business advisory lock for aggregateMetrics so concurrent sync paths
-- (runSync's per-sync aggregate + master/catchup-sync's post-aggregate +
-- on-demand /api/sync/today) can't race-overwrite daily_metrics rows.
--
-- Lock semantics:
--   • One row per business while aggregate is running.
--   • Stale rows (locked_at older than 60 s) are stolen — the previous
--     worker likely crashed before it could DELETE the row.
--   • Held rows are respected — the second caller logs and returns early.
--
-- This is a complement to FIXES.md §0l: that fix moved aggregate to a
-- per-business sweep at end-of-cron to dodge the race; this lock makes the
-- race impossible by serialising at the data layer.

CREATE TABLE IF NOT EXISTS aggregation_lock (
  business_id UUID         PRIMARY KEY,
  locked_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  locked_by   TEXT
);

-- Index for the staleness sweep (cheap on a tiny table but keeps the
-- planner honest if many businesses are active simultaneously).
CREATE INDEX IF NOT EXISTS aggregation_lock_locked_at_idx
  ON aggregation_lock (locked_at);

-- Verify
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'aggregation_lock'
 ORDER BY ordinal_position;
