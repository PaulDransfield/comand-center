-- M057 — business_feature_flags (per-business flag table)
--
-- Why a new table rather than extending feature_flags:
--   - Existing feature_flags is keyed (org_id, flag) and defaults
--     ENABLED. Used by lib/ai/is-agent-enabled.ts for org-scoped agent
--     opt-outs, where "no row = run the agent" is the right default.
--   - Prediction-system v2 flags need per-BUSINESS flips (Vero org
--     has two businesses; we want to flip Vero Italiano's anomaly UI
--     ON without affecting Rosali Deli) and they need to default OFF
--     because everything in Pieces 1-5 is "build on the side, gated"
--     until validation passes.
--   - Adding a business_id column to feature_flags + retrofitting every
--     existing reader is risky for a one-customer pre-launch system.
--     Parallel table is cleaner.
--
-- Same shape as feature_flags plus business_id; opposite default
-- (`enabled = false`). The lib/featureFlags/prediction-v2.ts wrapper in
-- Stream F.2 reads this; agent crons keep using is-agent-enabled.ts +
-- the org-scoped feature_flags table unchanged.
--
-- See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream F.1, Decision 2).
--
-- Run: open Supabase SQL Editor, paste this file, run.

CREATE TABLE IF NOT EXISTS public.business_feature_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  business_id UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  flag        TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT FALSE,  -- ← intentional inverse of feature_flags
  notes       TEXT,
  set_by      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, flag)
);

CREATE INDEX IF NOT EXISTS idx_business_feature_flags_lookup
  ON public.business_feature_flags (business_id, flag);

ALTER TABLE public.business_feature_flags ENABLE ROW LEVEL SECURITY;

-- Org members can SEE flags for businesses they own.
DROP POLICY IF EXISTS "business_feature_flags_select_own" ON public.business_feature_flags;
CREATE POLICY "business_feature_flags_select_own" ON public.business_feature_flags
  FOR SELECT
  USING (
    business_id IN (
      SELECT b.id FROM businesses b
      JOIN organisation_members m ON m.org_id = b.org_id
      WHERE m.user_id = auth.uid()
    )
  );

-- Writes go through service role only (admin UI / Stream F.2 wrapper).
-- No INSERT/UPDATE policy — service role bypasses RLS, matching
-- feature_flags + weather_daily.

-- Sanity: confirm the table exists and is empty (DDL only — no flags
-- flipped on by this migration; the Stream D anomaly UI flag flips ON
-- via admin UI at the end of Week 3 per Section 11 of the architecture).
SELECT COUNT(*) AS business_flag_rows FROM public.business_feature_flags;
