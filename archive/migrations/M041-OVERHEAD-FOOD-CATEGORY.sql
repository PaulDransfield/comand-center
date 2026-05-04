-- M041-OVERHEAD-FOOD-CATEGORY.sql
-- ============================================================================
-- Extends overhead_classifications + overhead_flags to also handle food
-- costs, not just other_cost. Adds a category column, replaces the natural
-- UNIQUE keys to include it, and CHECK-constrains the vocabulary so a future
-- regression can't silently write a third category.
--
-- Why: same supplier name CAN appear in both other_cost and food_cost
-- (same vendor billing for both subscription + ingredients) — without
-- category in the UNIQUE, the worker's idempotent insert would conflict
-- across the two streams and one of them would silently drop.
--
-- Existing rows default to category='other_cost' which is what the M039
-- + M040 era of the worker has been writing. No data migration needed.
-- ============================================================================

BEGIN;

-- ── 1. Add category column with default ───────────────────────────────────
ALTER TABLE overhead_classifications
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other_cost';

ALTER TABLE overhead_flags
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other_cost';

-- ── 2. CHECK constraints on the vocabulary ────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'overhead_classifications_category_chk'
  ) THEN
    ALTER TABLE overhead_classifications
      ADD CONSTRAINT overhead_classifications_category_chk
      CHECK (category IN ('other_cost', 'food_cost'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'overhead_flags_category_chk'
  ) THEN
    ALTER TABLE overhead_flags
      ADD CONSTRAINT overhead_flags_category_chk
      CHECK (category IN ('other_cost', 'food_cost'));
  END IF;
END $$;

-- ── 3. Replace UNIQUE constraints to include category ─────────────────────
-- Both tables had auto-named UNIQUE constraints from M039. Drop every
-- existing UNIQUE on these tables (PK survives because contype='p') and
-- recreate with named constraints that include category. Safe because
-- these tables are owned by this feature; no foreign-key UNIQUE deps elsewhere.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'overhead_classifications'::regclass AND contype = 'u'
  LOOP
    EXECUTE 'ALTER TABLE overhead_classifications DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'overhead_flags'::regclass AND contype = 'u'
  LOOP
    EXECUTE 'ALTER TABLE overhead_flags DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

ALTER TABLE overhead_classifications
  ADD CONSTRAINT overhead_classifications_natural_key
  UNIQUE (business_id, supplier_name_normalised, category);

ALTER TABLE overhead_flags
  ADD CONSTRAINT overhead_flags_idempotency_key
  UNIQUE (business_id, source_upload_id, supplier_name_normalised, flag_type, category);

-- ── 4. Index for category filtering (PR will surface category badges + sum) ─
CREATE INDEX IF NOT EXISTS idx_overhead_flags_category_pending
  ON overhead_flags (business_id, category, surfaced_at DESC)
  WHERE resolution_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_overhead_classifications_category
  ON overhead_classifications (business_id, category, status);

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT 'category coverage' AS check, table_name, column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name IN ('overhead_classifications', 'overhead_flags')
   AND column_name = 'category';

SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid IN ('overhead_classifications'::regclass, 'overhead_flags'::regclass)
   AND contype IN ('u', 'c')
 ORDER BY conrelid::regclass::text, conname;

COMMIT;
