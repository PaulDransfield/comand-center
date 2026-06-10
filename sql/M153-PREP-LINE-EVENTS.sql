-- M153 — append-only audit log for prep-list completions.
--
-- prep_session_lines already carries the LATEST state (checked_at + checked_by),
-- but un-checking a line erases who did it. For real "accountability through
-- the process" (owner decision 2026-06-10) we record every check / uncheck as
-- an immutable event: who, when, which line, which action. The line keeps the
-- current state for fast reads; this table keeps the history.
--
-- Server-side only (service_role via the toggle endpoint). RLS enabled with no
-- policy = deny-all for anon/authenticated, which is correct.
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.prep_session_line_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  business_id uuid NOT NULL,
  session_id  uuid NOT NULL,
  line_id     uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('checked', 'unchecked')),
  user_id     uuid,                     -- who did it (null only if somehow unauthenticated)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prep_line_events_session_idx ON public.prep_session_line_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS prep_line_events_line_idx    ON public.prep_session_line_events (line_id, created_at);
CREATE INDEX IF NOT EXISTS prep_line_events_business_idx ON public.prep_session_line_events (business_id, created_at);

ALTER TABLE public.prep_session_line_events ENABLE ROW LEVEL SECURITY;
