-- M072 — add 'revisor' as a valid value on organisation_members.role
--
-- Phase D of the v2 roadmap: read-only account for the customer's external
-- accountant. Unique to the Nordic market — UK ops (Nory's market) don't
-- have this revisor relationship.
--
-- The role was constrained to ('owner', 'manager', 'viewer') by M043. We
-- extend that allow-list with 'revisor'. Same scoping mechanism (business_ids
-- nullable; can_view_finances ignored since revisor sees finances by
-- definition).
--
-- Idempotent: detects existing constraint, drops + recreates with the
-- extended allow-list. Same pattern M064 used for integrations.status.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organisation_members_role_chk'
  ) THEN
    ALTER TABLE organisation_members
      DROP CONSTRAINT organisation_members_role_chk;
  END IF;

  ALTER TABLE organisation_members
    ADD CONSTRAINT organisation_members_role_chk
    CHECK (role IN ('owner', 'manager', 'viewer', 'revisor'));
END $$;

-- Verify
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname = 'organisation_members_role_chk';

-- Distribution
SELECT role, COUNT(*) FROM organisation_members GROUP BY role ORDER BY 2 DESC;

COMMIT;
