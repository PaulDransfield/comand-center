-- M052 — Backfill tracker_data.created_via for pre-M047 rows
--
-- Why: M047 added the `created_via` column on `tracker_data` and tagged
-- every NEW write going forward. Older rows (created before M047) have
-- NULL. The Piece 0 prediction-system investigation flagged ~21 NULLs
-- that need an explicit origin tag so future audit/aggregation queries
-- don't have to special-case `IS NULL`.
--
-- This migration is a one-line idempotent UPDATE:
--   - Sets every still-NULL `created_via` to 'manual_pre_m047' (the
--     honest interpretation: nobody knows the exact provenance, but
--     these all pre-date the M047 instrumentation).
--   - Re-running is safe (the WHERE clause matches nothing on the second
--     run because every NULL has been replaced).
--
-- See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream C).
--
-- Run: open Supabase SQL Editor, paste this file, run.

UPDATE tracker_data
SET created_via = 'manual_pre_m047'
WHERE created_via IS NULL;

-- Sanity check — should return 0 after the UPDATE above.
SELECT COUNT(*) AS remaining_null_created_via
FROM tracker_data
WHERE created_via IS NULL;
