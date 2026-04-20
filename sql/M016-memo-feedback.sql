-- M016 — memo_feedback table
--
-- Captures thumbs up / thumbs down (+ optional comment) from the Monday memo
-- email. Recorded via the public /api/memo-feedback endpoint, which verifies
-- an HMAC-signed token embedded in the email links so only the recipient can
-- vote for their own briefing.
--
-- One vote per briefing — repeat clicks update the existing row instead of
-- stacking. This keeps the signal clean (we care about "did this memo land?",
-- not click counts).
--
-- Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS memo_feedback (
  briefing_id   UUID PRIMARY KEY REFERENCES briefings(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rating        TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  comment       TEXT,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memo_feedback_org_submitted_idx
  ON memo_feedback (org_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS memo_feedback_submitted_idx
  ON memo_feedback (submitted_at DESC);

ALTER TABLE memo_feedback ENABLE ROW LEVEL SECURITY;

-- Owners can see their own org's feedback (for a future in-app view).
-- Writes go through the service-role-backed API endpoint which bypasses RLS.
DROP POLICY IF EXISTS "memo_feedback_select_own" ON memo_feedback;
CREATE POLICY "memo_feedback_select_own" ON memo_feedback
  FOR SELECT
  USING (
    org_id IN (
      SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION memo_feedback_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memo_feedback_updated_at ON memo_feedback;
CREATE TRIGGER memo_feedback_updated_at
  BEFORE UPDATE ON memo_feedback
  FOR EACH ROW EXECUTE FUNCTION memo_feedback_touch_updated_at();
