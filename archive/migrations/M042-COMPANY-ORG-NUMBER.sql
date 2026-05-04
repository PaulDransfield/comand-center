-- M042-COMPANY-ORG-NUMBER.sql
-- ============================================================================
-- Adds Swedish organisationsnummer to organisations + businesses.
--
-- organisations.org_number — REQUIRED at signup going forward, optional
--   for existing customers (with a 30-day grace period after which the
--   app hard-blocks until they fill it in).
-- businesses.org_number — OPTIONAL. Used when a customer runs multiple
--   restaurants under separate ABs; falls back to the parent
--   organisations.org_number when blank.
--
-- Format: 10 digits, no dashes, validated by CHECK at the DB layer.
-- The display layer renders as XXXXXX-XXXX. Server-side validator in
-- lib/sweden/orgnr.ts also runs the Luhn-style checksum.
--
-- Grace tracking: org_number_grace_started_at is the moment the
-- requirement was introduced for existing accounts. On migration apply,
-- defaults to now() for every existing row, giving them 30 days from
-- this PR shipping to comply. New signups have org_number set
-- immediately so the grace timestamp is irrelevant.
--
-- IMPORTANT: This migration does pre-existing-data normalisation BEFORE
-- adding either CHECK constraint. The first run errored on Vero/Rosali
-- because some businesses.org_number rows pre-dated the CHECK and
-- carried dashes/spaces. The strip-non-digits + blank-if-still-invalid
-- step must therefore run before either constraint goes on.
-- ============================================================================

BEGIN;

-- ── 1. Add columns first (idempotent — safe re-run after partial apply) ──

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS org_number                  TEXT,
  ADD COLUMN IF NOT EXISTS org_number_set_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS org_number_grace_started_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS org_number TEXT;

-- ── 2. Normalise pre-existing data BEFORE adding any CHECK ───────────────
-- Strip non-digits; if the result isn't exactly 10 digits, NULL it out.
-- Customer can re-enter via /settings/company. Both tables get the same
-- treatment in case rogue data exists in either.

UPDATE businesses
   SET org_number = NULLIF(regexp_replace(org_number, '\D', '', 'g'), '')
 WHERE org_number IS NOT NULL
   AND org_number ~ '\D';

UPDATE businesses
   SET org_number = NULL
 WHERE org_number IS NOT NULL
   AND org_number !~ '^[0-9]{10}$';

UPDATE organisations
   SET org_number = NULLIF(regexp_replace(org_number, '\D', '', 'g'), '')
 WHERE org_number IS NOT NULL
   AND org_number ~ '\D';

UPDATE organisations
   SET org_number = NULL
 WHERE org_number IS NOT NULL
   AND org_number !~ '^[0-9]{10}$';

-- ── 3. CHECK constraints — now safe to add ────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organisations_org_number_format_chk'
  ) THEN
    ALTER TABLE organisations
      ADD CONSTRAINT organisations_org_number_format_chk
      CHECK (org_number IS NULL OR org_number ~ '^[0-9]{10}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_org_number_format_chk'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_org_number_format_chk
      CHECK (org_number IS NULL OR org_number ~ '^[0-9]{10}$');
  END IF;
END $$;

-- ── 4. Indexes for fast org-nr lookup ────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_organisations_org_number
  ON organisations (org_number)
  WHERE org_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_org_number
  ON businesses (org_number)
  WHERE org_number IS NOT NULL;

-- ── Verify ──────────────────────────────────────────────────────────────────

SELECT 'organisations' AS tbl, column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'organisations'
   AND column_name IN ('org_number', 'org_number_set_at', 'org_number_grace_started_at')
UNION ALL
SELECT 'businesses' AS tbl, column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'businesses'
   AND column_name = 'org_number';

SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname IN ('organisations_org_number_format_chk', 'businesses_org_number_format_chk');

-- Show what got normalised — any rows we coerced will now show as NULL.
SELECT 'businesses_with_orgnr' AS metric, COUNT(*) FROM businesses WHERE org_number IS NOT NULL
UNION ALL
SELECT 'businesses_without_orgnr', COUNT(*) FROM businesses WHERE org_number IS NULL
UNION ALL
SELECT 'organisations_with_orgnr', COUNT(*) FROM organisations WHERE org_number IS NOT NULL
UNION ALL
SELECT 'organisations_without_orgnr', COUNT(*) FROM organisations WHERE org_number IS NULL;

COMMIT;
