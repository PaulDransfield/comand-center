-- M032-FORTNOX-SUPERSEDE-CHAIN.sql
-- ============================================================================
-- Per-period supersede join table for fortnox_uploads. Replaces the broken
-- column-based supersede chain on multi-month uploads.
--
-- Pre-fix: app/api/fortnox/apply/route.ts loops periods and calls
-- applyMonthly, which writes supersedes_id / superseded_by_id on the
-- current upload row each iteration. With 12 periods → 12 overwrites →
-- only the last period's parent is recorded. The chain is broken for any
-- upload that supersedes a multi-month predecessor at more than one period.
--
-- Symptom (FIXES §0v): Rosali had two applied multi-month uploads
-- (Resultatrapport 2025.pdf and Resultatrapport_Asp_2603.pdf) for
-- overlapping periods, both with supersedes_id NULL — the supersede
-- relationship was lost on every iteration but the last.
--
-- Fix: per-(child_id, parent_id, year, month) rows in this join table.
-- Each iteration of applyMonthly inserts one row. Reject path walks the
-- table to restore predecessors per-period instead of from the column.
--
-- Backwards compat: supersedes_id / superseded_by_id columns on
-- fortnox_uploads stay. Single-month uploads still write them (one
-- iteration = one column value, accurate). Multi-month uploads will end
-- up with the LAST period's parent in those columns — non-load-bearing
-- and documented in code; the join table is the source of truth.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fortnox_supersede_links (
  child_id     UUID     NOT NULL REFERENCES fortnox_uploads(id) ON DELETE CASCADE,
  parent_id    UUID     NOT NULL REFERENCES fortnox_uploads(id) ON DELETE CASCADE,
  period_year  SMALLINT NOT NULL,
  period_month SMALLINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (child_id, parent_id, period_year, period_month)
);

-- Hot lookup paths:
--   apply.ts: when child applies, find priors per (parent, year, month)
--   reject.ts: when child is rejected, find all parents to restore
CREATE INDEX IF NOT EXISTS idx_supersede_child  ON fortnox_supersede_links (child_id);
CREATE INDEX IF NOT EXISTS idx_supersede_parent ON fortnox_supersede_links (parent_id);

-- Service-role only — apply/reject routes use the admin client. No policy
-- needed; RLS is enabled but no SELECT/INSERT policy is defined, so the
-- anon/authenticated roles get no access at all.
ALTER TABLE fortnox_supersede_links ENABLE ROW LEVEL SECURITY;

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'fortnox_supersede_links'
 ORDER BY ordinal_position;

SELECT indexname FROM pg_indexes
 WHERE tablename = 'fortnox_supersede_links'
 ORDER BY indexname;

COMMIT;
