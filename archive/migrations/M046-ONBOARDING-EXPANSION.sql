-- M046-ONBOARDING-EXPANSION.sql
-- Purpose: collect more business context up-front so the AI has anchors
--          from day 1 instead of waiting 12 months for Fortnox uploads.
--
-- New columns on businesses:
--   - opening_days   JSONB — { mon, tue, wed, thu, fri, sat, sun: bool }.
--                    Drives scheduling AI (no labour-cut suggestions on
--                    closed days) and the /scheduling page weekly grid.
--                    Default = open every day so legacy rows render
--                    sensibly until owners update.
--   - business_stage TEXT — 'new' | 'established_1y' | 'established_3y'.
--                    Drives budget AI: 'new' skips the historical-anchor
--                    rule (no last-year actuals exist), 'established_*'
--                    enforces it. Nullable for backfill safety.
--
-- Backwards compat: pure additions, defaults sensible for existing rows,
-- IF NOT EXISTS makes re-runs safe. Wrapped in a transaction.
--
-- Companion code:
--   - app/api/businesses/add/route.ts   (writes both fields on create)
--   - app/api/onboarding/complete/route.ts (also writes organisations.org_number)
--   - app/onboarding/page.tsx           (UI capture)
--
-- After applying: M042's 30-day grace banner/gate is dead code — onboarding
-- now requires org_number upfront. Components OrgNumberBanner / OrgNumberGate
-- are removed in the same change.

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS opening_days   JSONB
    DEFAULT '{"mon":true,"tue":true,"wed":true,"thu":true,"fri":true,"sat":true,"sun":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS business_stage TEXT;

-- Enum-style guard. NULL allowed so legacy rows aren't forced into a bucket
-- they don't fit; new onboarding always writes one of the three values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'businesses' AND constraint_name = 'businesses_business_stage_check'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_business_stage_check
      CHECK (business_stage IS NULL OR business_stage IN ('new', 'established_1y', 'established_3y'));
  END IF;
END$$;

COMMIT;

-- Verify
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'businesses'
   AND column_name IN ('opening_days', 'business_stage', 'address', 'org_number')
 ORDER BY column_name;
