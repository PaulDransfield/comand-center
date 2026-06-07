-- M137 — Products data-layer upgrade
--
-- Adds the columns the catalogue has been missing for structured
-- organisation: sub_category, storage_type, brand, gtin, allergens,
-- plus classification provenance fields.
--
-- Designed once, never extended ad-hoc — see lib/inventory/taxonomy.ts
-- for the canonical enum lists (CHECK constraints below mirror them).
--
-- Idempotent — safe to re-run. ADD COLUMN IF NOT EXISTS + DO/END for
-- constraints.

BEGIN;

-- ── Columns ─────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sub_category               TEXT,
  ADD COLUMN IF NOT EXISTS storage_type               TEXT,
  ADD COLUMN IF NOT EXISTS brand                      TEXT,
  ADD COLUMN IF NOT EXISTS gtin                       TEXT,
  ADD COLUMN IF NOT EXISTS allergens                  TEXT[],
  ADD COLUMN IF NOT EXISTS classification_source      TEXT,
  ADD COLUMN IF NOT EXISTS classification_confidence  NUMERIC,
  ADD COLUMN IF NOT EXISTS classification_last_at     TIMESTAMPTZ;

-- ── CHECK constraints ──────────────────────────────────────────────
-- storage_type enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_storage_type_chk') THEN
    ALTER TABLE products
      ADD CONSTRAINT products_storage_type_chk
      CHECK (storage_type IS NULL OR storage_type IN ('frozen', 'refrigerated', 'ambient'));
  END IF;
END $$;

-- classification_source enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_classification_source_chk') THEN
    ALTER TABLE products
      ADD CONSTRAINT products_classification_source_chk
      CHECK (classification_source IS NULL OR classification_source IN (
        'owner', 'supplier_articles', 'cross_customer', 'openfoodfacts', 'web_llm', 'name_llm'
      ));
  END IF;
END $$;

-- classification_confidence in [0, 1]
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_classification_confidence_chk') THEN
    ALTER TABLE products
      ADD CONSTRAINT products_classification_confidence_chk
      CHECK (classification_confidence IS NULL OR (classification_confidence >= 0 AND classification_confidence <= 1));
  END IF;
END $$;

-- gtin: 8/12/13/14 digits — defensive, allow free-form but trim
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_gtin_format_chk') THEN
    ALTER TABLE products
      ADD CONSTRAINT products_gtin_format_chk
      CHECK (gtin IS NULL OR gtin ~ '^[0-9]{8,14}$');
  END IF;
END $$;

-- ── Indexes ─────────────────────────────────────────────────────────
-- (business_id, sub_category) for filter pills + cost-rollup queries
CREATE INDEX IF NOT EXISTS products_business_sub_category_idx
  ON public.products (business_id, sub_category)
  WHERE archived_at IS NULL AND sub_category IS NOT NULL;

-- (business_id, storage_type) for prep/order grouping by zone
CREATE INDEX IF NOT EXISTS products_business_storage_type_idx
  ON public.products (business_id, storage_type)
  WHERE archived_at IS NULL AND storage_type IS NOT NULL;

-- brand search
CREATE INDEX IF NOT EXISTS products_business_brand_idx
  ON public.products (business_id, brand)
  WHERE archived_at IS NULL AND brand IS NOT NULL;

-- GTIN — cross-supplier identity lookup. Not unique (different
-- businesses can have the same GTIN; we don't ban that yet).
CREATE INDEX IF NOT EXISTS products_gtin_idx
  ON public.products (gtin)
  WHERE archived_at IS NULL AND gtin IS NOT NULL;

-- needs-classification queue surface — products where sub_category
-- is null OR confidence is low. Partial index keeps it tight.
CREATE INDEX IF NOT EXISTS products_needs_classification_idx
  ON public.products (business_id, classification_confidence)
  WHERE archived_at IS NULL AND (sub_category IS NULL OR classification_confidence < 0.7);

-- ── Comments ────────────────────────────────────────────────────────
COMMENT ON COLUMN products.sub_category IS
  'M137 — owner-readable sub-category (dairy_cheese, meat_beef, alc_wine_red etc.). Canonical list in lib/inventory/taxonomy.ts. NULL until classified.';
COMMENT ON COLUMN products.storage_type IS
  'M137 — frozen | refrigerated | ambient. Sourced from supplier_articles.storage_type when available.';
COMMENT ON COLUMN products.brand IS
  'M137 — canonical brand name (Arla, Coca-Cola, Mutti, etc.). Cross-customer enrichment target.';
COMMENT ON COLUMN products.gtin IS
  'M137 — EAN/GTIN-8/12/13/14. Cross-supplier identity — two suppliers selling the same GTIN are the same SKU.';
COMMENT ON COLUMN products.allergens IS
  'M137 — array of allergen keys (dairy, eggs, gluten, fish, shellfish, etc.). Seeded from taxonomy default + supplier_articles overrides.';
COMMENT ON COLUMN products.classification_source IS
  'M137 — provenance of sub_category/storage/brand/allergens: owner | supplier_articles | cross_customer | openfoodfacts | web_llm | name_llm. owner = manual override (highest priority).';
COMMENT ON COLUMN products.classification_confidence IS
  'M137 — [0, 1]. owner=1.0, supplier_articles=0.95, cross_customer=0.90, openfoodfacts=0.85, web_llm=0.70, name_llm=0.50. <0.7 flagged for owner review.';
COMMENT ON COLUMN products.classification_last_at IS
  'M137 — when the classification was last set/refreshed. Used by re-classify sweeps to skip recently-classified rows.';

COMMIT;
