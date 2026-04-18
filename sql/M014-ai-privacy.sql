-- M014-ai-privacy.sql
-- Per-organisation opt-out for storing AI question previews.
-- When log_ai_questions is false, ai_request_log.question_preview stays null
-- for that org's queries — token counts, model, cost still logged.
-- Default true (we want the data to improve quality) but customers can
-- toggle off in Settings for stricter privacy posture.

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS log_ai_questions boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organisations.log_ai_questions IS
  'If true, the first 100 chars of AI questions are stored in ai_request_log.question_preview for debugging/quality. If false, that field stays null. Token counts + cost always logged regardless.';
