-- M154 — stock_counts.active_seconds
-- Status: ALREADY APPLIED 2026-06-12 (via the Supabase migration tool).
--   Safe to re-run (IF NOT EXISTS). Here for the repo record.
--
-- Accumulated ACTIVE counting time (seconds). The count page pings this up
-- while open + visible + not completed, so "time to count" measures actual
-- time spent and pauses when the owner leaves the page. Replaces the old
-- created_at->completed_at wall-clock, which inflated across days.

ALTER TABLE public.stock_counts
  ADD COLUMN IF NOT EXISTS active_seconds integer NOT NULL DEFAULT 0;
