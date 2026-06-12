-- M156 — prep_session_lines per-dish columns
-- Status: ALREADY APPLIED 2026-06-12 (via the Supabase migration tool).
--   Safe to re-run (IF NOT EXISTS). Here for the repo record.
--
-- Per-dish prep lines. Previously lines were aggregated across all dishes
-- (one "Tomatoes 5kg" line summed over every dish). Now each line belongs to
-- a specific parent dish (frozen at save, like the quantities) so the prep
-- list can be grouped per dish. Totals are derived by summing at read time.
-- Nullable for backward compatibility: legacy sessions render as "All items".

ALTER TABLE public.prep_session_lines
  ADD COLUMN IF NOT EXISTS dish_recipe_id     uuid,
  ADD COLUMN IF NOT EXISTS dish_name_snapshot text;
