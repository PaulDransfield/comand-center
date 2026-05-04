-- M044-USER-LOCALE.sql
-- ============================================================================
-- Per-user locale preference for the i18n rollout (en-GB / sv / nb).
--
-- Stored on organisation_members rather than auth.users so:
--   - The user's preference is org-scoped (one user in two orgs could
--     choose different default languages — rare but cheap to support).
--   - Reads piggyback on the existing membership SELECT in getRequestAuth,
--     no extra round-trip.
--
-- Anonymous visitors (landing page, signup) get their locale from a cookie
-- set by the i18n middleware based on Accept-Language. On signup, the
-- cookie value is migrated into this column so the first-authed-render
-- doesn't flicker back to the default.
-- ============================================================================

BEGIN;

ALTER TABLE organisation_members
  ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en-GB';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organisation_members_locale_chk'
  ) THEN
    ALTER TABLE organisation_members
      ADD CONSTRAINT organisation_members_locale_chk
      CHECK (locale IN ('en-GB', 'sv', 'nb'));
  END IF;
END $$;

-- Verify
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'organisation_members'
   AND column_name = 'locale';

SELECT locale, COUNT(*)
  FROM organisation_members
  GROUP BY locale
  ORDER BY 2 DESC;

COMMIT;
