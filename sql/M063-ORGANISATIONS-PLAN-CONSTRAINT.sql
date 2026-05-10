-- M063 — extend organisations.plan CHECK constraint to include 2026-04 pricing
--
-- The 2026-04-23 pricing overhaul added four new plan values:
--   founding, solo, group, chain
-- (per project_pricing_2026_04 memory and lib/stripe/config.ts)
--
-- These shipped into the code (PLANS map) but the DB CHECK constraint
-- still enumerated the old set (trial, starter, pro, enterprise, past_due).
-- Result: any UPDATE setting a new value failed:
--
--   ERROR: new row for relation "organisations" violates check constraint
--   "organisations_plan_check"
--
-- This migration drops + re-creates the constraint with all current values.
-- Idempotent. Pre-existing rows on legacy plan values stay valid.

ALTER TABLE public.organisations
  DROP CONSTRAINT IF EXISTS organisations_plan_check;

ALTER TABLE public.organisations
  ADD CONSTRAINT organisations_plan_check
  CHECK (plan IN (
    -- Legacy / pre-overhaul (still in use by some existing rows)
    'trial',
    'starter',
    'pro',
    'enterprise',
    'past_due',
    -- 2026-04-23 pricing overhaul (project_pricing_2026_04 memory)
    'founding',
    'solo',
    'group',
    'chain'
  ));

-- Verification: list current plan distribution
SELECT plan, COUNT(*) AS rows
FROM public.organisations
GROUP BY plan
ORDER BY plan NULLS LAST;
