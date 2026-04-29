-- M043-MEMBER-ROLES-AND-SCOPING.sql
-- ============================================================================
-- Role-based access for staff under a customer's organisation.
--
-- Owner emails CommandCenter (paul@) — "give my manager John access, only
-- scheduling + staff". Paul provisions via the Admin v2 Users sub-tab on
-- the customer-detail page (concierge model — no self-service invite flow
-- in v1). System creates an auth user, inserts a row here, sends the user
-- a password-reset email.
--
-- Roles:
--   owner   — full access (existing default for the signup user)
--   manager — operations only by default (dashboard, scheduling, staff,
--             revenue, departments, alerts). NO finance pages, settings,
--             billing, or AI assistant.
--
-- Scoping:
--   business_ids = NULL → all businesses in the org (single-restaurant
--                         case, or unscoped manager).
--   business_ids = [...] → limited to those businesses. Server-side filter
--                          applied to every business-scoped API route.
--
-- Permission overrides:
--   can_view_finances → boolean escape-hatch. Set TRUE to let a manager
--                       see /tracker, /budget, /forecast, /overheads.
--                       Default FALSE. Owners ignore the flag.
-- ============================================================================

BEGIN;

-- ── 1. Role vocabulary CHECK ─────────────────────────────────────────────
-- The role column already exists. Coerce any rogue legacy values to
-- 'owner' (since the only existing rows are the original signup users)
-- before adding the constraint.

UPDATE organisation_members
   SET role = 'owner'
 WHERE role IS NULL
    OR role NOT IN ('owner', 'manager', 'viewer');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organisation_members_role_chk'
  ) THEN
    ALTER TABLE organisation_members
      ADD CONSTRAINT organisation_members_role_chk
      CHECK (role IN ('owner', 'manager', 'viewer'));
  END IF;
END $$;

-- ── 2. Scoping + permission columns ──────────────────────────────────────

ALTER TABLE organisation_members
  ADD COLUMN IF NOT EXISTS business_ids       UUID[],                              -- NULL = all in org
  ADD COLUMN IF NOT EXISTS can_view_finances  BOOLEAN NOT NULL DEFAULT FALSE,      -- escape hatch for finance-trusted managers
  ADD COLUMN IF NOT EXISTS invited_by         UUID,                                -- who provisioned this member (paul-the-admin or owner)
  ADD COLUMN IF NOT EXISTS invited_at         TIMESTAMPTZ,                         -- when provisioned
  ADD COLUMN IF NOT EXISTS last_active_at     TIMESTAMPTZ;                         -- updated on each authed request (best-effort)

-- Hot lookup: members for an org, filtered by role. Used by the Users
-- sub-tab + (later) any cross-org admin queries.
CREATE INDEX IF NOT EXISTS idx_organisation_members_org_role
  ON organisation_members (org_id, role);

-- ── Verify ──────────────────────────────────────────────────────────────────

SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'organisation_members'
   AND column_name IN ('role', 'business_ids', 'can_view_finances', 'invited_by', 'invited_at', 'last_active_at')
 ORDER BY column_name;

SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname = 'organisation_members_role_chk';

-- Distribution check: how many members of each role today.
SELECT role, COUNT(*) FROM organisation_members GROUP BY role ORDER BY 2 DESC;

COMMIT;
