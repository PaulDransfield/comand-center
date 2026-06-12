-- M155 — schedule_ai_suggestions.reason_code
-- Status: ALREADY APPLIED 2026-06-12 (via the Supabase migration tool).
--   Safe to re-run (IF NOT EXISTS). Here for the repo record.
--
-- Structured rejection reason for AI scheduling suggestions. owner_reason
-- holds the free-text/label; reason_code is the controlled-vocab category
-- (busier_than_forecast, booking_or_event, ...) so we can aggregate WHY
-- owners reject and feed cleaner signal back into the next AI run.

ALTER TABLE public.schedule_ai_suggestions
  ADD COLUMN IF NOT EXISTS reason_code text;
