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

-- Drop any existing CHECK constraint on `role` regardless of name. M043
-- created `_role_chk`; Postgres' auto-generated default may have been
-- `_role_check` (depending on how the original column-level CHECK was
-- specified). Walk pg_constraint to find any CHECK on this table that
-- references the `role` column and drop it before re-adding ours.
DO $$
DECLARE
  c_name TEXT;
BEGIN
  FOR c_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'organisation_members'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE organisation_members DROP CONSTRAINT %I', c_name);
  END LOOP;

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
