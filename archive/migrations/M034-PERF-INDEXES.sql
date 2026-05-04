-- ════════════════════════════════════════════════════════════════════════════
-- M034 · Performance indexes for revenue_logs and staff_logs
-- ════════════════════════════════════════════════════════════════════════════
-- Both tables pre-date the M008 summary-tables migration so they never had
-- any indexes added. /api/departments paginates through both on every
-- dashboard load. With <10 k rows total today the seq scan is invisible;
-- at 50 customers × 2 years of history (~200 k+ rows) it becomes the
-- slowest query in the system.
--
-- Two indexes per table:
--   • (org_id, business_id, date) — hot path for /api/departments and any
--     other route that scopes by tenant + business + date range.
--   • (org_id, [filter_col], date) — secondary filter the same route uses
--     (revenue_logs.provider via .in('provider', ...) ; staff_logs.staff_group
--     via .in('staff_group', deptNames)).
--
-- ── PRODUCTION NOTE ─────────────────────────────────────────────────────────
-- CREATE INDEX CONCURRENTLY can't run inside a transaction block. If you
-- paste this whole file at once into the Supabase SQL Editor it will fail.
-- Instead, run each CREATE INDEX statement INDIVIDUALLY (one at a time).
-- The CONCURRENTLY variant avoids an exclusive table lock, which matters at
-- production scale even though it doesn't matter today (rows are tiny).
--
-- For a dev/local run where locking doesn't matter, the IF NOT EXISTS
-- versions below work fine in a single shot.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Production-safe variants (run one at a time) ───────────────────────────
-- Uncomment these and run separately if applying to live production:
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_revenue_logs_org_biz_date
--   ON revenue_logs (org_id, business_id, revenue_date);
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_revenue_logs_org_provider_date
--   ON revenue_logs (org_id, provider, revenue_date);
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staff_logs_org_biz_date
--   ON staff_logs (org_id, business_id, shift_date);
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_staff_logs_org_group_date
--   ON staff_logs (org_id, staff_group, shift_date);

-- ── Dev / single-shot variants (safe at current data volume) ───────────────
CREATE INDEX IF NOT EXISTS idx_revenue_logs_org_biz_date
  ON revenue_logs (org_id, business_id, revenue_date);

CREATE INDEX IF NOT EXISTS idx_revenue_logs_org_provider_date
  ON revenue_logs (org_id, provider, revenue_date);

CREATE INDEX IF NOT EXISTS idx_staff_logs_org_biz_date
  ON staff_logs (org_id, business_id, shift_date);

CREATE INDEX IF NOT EXISTS idx_staff_logs_org_group_date
  ON staff_logs (org_id, staff_group, shift_date);

-- ── Verification ────────────────────────────────────────────────────────────
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename IN ('revenue_logs', 'staff_logs')
   AND indexname LIKE 'idx_%_date'
 ORDER BY indexname;
-- Expected: 4 rows, one per CREATE INDEX above.

-- Optional sanity: confirm the planner uses them.
-- (Replace the UUID + dates with real ones from your env.)
--
-- EXPLAIN ANALYZE
-- SELECT revenue_date, provider, revenue
--   FROM revenue_logs
--  WHERE org_id = '00000000-0000-0000-0000-000000000000'
--    AND business_id = '00000000-0000-0000-0000-000000000000'
--    AND revenue_date >= '2026-04-01';
-- → should show "Index Scan using idx_revenue_logs_org_biz_date" not "Seq Scan".
