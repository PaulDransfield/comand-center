-- M158 — waste_log.waste_date default
-- Status: ALREADY APPLIED 2026-06-12 (via the Supabase migration tool).
--   Safe to re-run. Here for the repo record.
--
-- waste_date is NOT NULL but had no default, so any INSERT that omitted it
-- failed (the per-dish prep "anything go in the bin?" prompt didn't send one).
-- The API now always supplies today's date (Stockholm); this default is
-- belt-and-braces for any future caller that omits the column. NB: a default
-- only applies when the column is OMITTED — an explicit NULL still fails, which
-- is why the API fix (default in code) is the primary guard.

ALTER TABLE public.waste_log ALTER COLUMN waste_date SET DEFAULT CURRENT_DATE;
