-- M049-INTEGRATIONS-OAUTH-UPSERT-KEY.sql
-- ============================================================================
-- Fortnox OAuth callback upsert was failing with HTTP 400 / Postgres 42P10
-- ("there is no unique or exclusion constraint matching the ON CONFLICT
-- specification"). Root cause: the existing unique enforcement on the
-- integrations table is via PARTIAL indexes (`WHERE department IS NULL`,
-- `WHERE business_id IS NOT NULL`, etc.), but PostgREST's `?onConflict=...`
-- syntax only matches NON-partial unique constraints/indexes by column list.
--
-- The existing partial indexes correctly enforce row-level uniqueness for
-- every real shape of integrations row. They do NOT need to be removed.
-- This migration ADDS a non-partial unique index on (org_id, business_id,
-- provider) so the upsert in app/api/integrations/fortnox/route.ts can
-- target it. The new index is functionally redundant with the existing
-- `integrations_org_biz_provider_dept_unique` for the common case
-- (business_id IS NOT NULL) — that partial already enforces uniqueness
-- on (org_id, business_id, provider, COALESCE(department, '')) for
-- business_id-non-null rows, so any row that the new index would block
-- is already blocked. The new index just exposes the constraint to
-- PostgREST in a shape it can use.
--
-- Caveat — NULL business_id: Postgres treats NULL as distinct under a
-- standard UNIQUE index, so this index does NOT dedupe rows with
-- business_id IS NULL. Those are already covered by the existing
-- `integrations_org_null_biz_provider_unique` partial. New OAuth
-- callbacks will always carry a non-null business_id thanks to the
-- /integrations page-button guard (commit 66ffb5b), so this gap doesn't
-- affect the OAuth path. Admin concierge tokens that omit business_id
-- can still produce NULL — separate hardening item, not load-bearing here.
-- ============================================================================

BEGIN;

-- ── Pre-flight: surface any existing duplicates that would block creation ───
-- If this returns rows, STOP and resolve duplicates before re-running. The
-- existing partial indexes should have prevented duplicates for the common
-- case, but data predating those indexes might still have them.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT 1
      FROM integrations
     WHERE business_id IS NOT NULL
     GROUP BY org_id, business_id, provider
    HAVING COUNT(*) > 1
  ) t;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Found % duplicate (org_id, business_id, provider) groups in integrations — resolve before applying M049. Query: SELECT org_id, business_id, provider, COUNT(*) FROM integrations WHERE business_id IS NOT NULL GROUP BY 1,2,3 HAVING COUNT(*) > 1;', dup_count;
  END IF;
END $$;

-- ── Add the non-partial unique index PostgREST onConflict can match ──────────
CREATE UNIQUE INDEX IF NOT EXISTS integrations_org_biz_provider_uniq
  ON integrations (org_id, business_id, provider);

COMMENT ON INDEX integrations_org_biz_provider_uniq IS
  'Non-partial UNIQUE for PostgREST onConflict=org_id,business_id,provider upserts. Coexists with the existing partial indexes (uniq_with_dept / uniq_no_dept / org_biz_provider_dept_unique / org_null_biz_provider_unique). Added by M049.';

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'integrations'
   AND indexname = 'integrations_org_biz_provider_uniq';

COMMIT;

-- ── Rollback (if ever needed) ────────────────────────────────────────────────
-- DROP INDEX IF EXISTS integrations_org_biz_provider_uniq;
