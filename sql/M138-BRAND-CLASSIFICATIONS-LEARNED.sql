-- M138 — brand_classifications_learned
--
-- Global cross-customer brand → sub_category map that grows
-- automatically as owners override AI classifications. Bridges the
-- gap between hand-curated lib/inventory/brand-mapper.ts (~100 brands)
-- and the long tail of supplier brands we'll never code by hand.
--
-- Population rule (enforced server-side in the PATCH endpoint):
--   When owner saves a sub_category override, we look up all
--   owner-classified products globally that share the same brand.
--   If a sub_category dominates (≥ 80 % agreement AND ≥ 3 samples)
--   we upsert that brand → sub_category here. The cascade then reads
--   it as a learned source between cross_customer and openfoodfacts.
--
-- GLOBAL not per-business. "Coca-Cola" means the same thing at every
-- restaurant; a brand whose meaning varies per customer (a generic
-- like "Martin & Servera" own-brand) won't reach 80 % agreement and
-- naturally falls back to LLM.
--
-- Idempotent. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.brand_classifications_learned (
  brand              TEXT PRIMARY KEY,
  sub_category       TEXT NOT NULL,
  confidence         NUMERIC NOT NULL,            -- agreement ratio at last recompute
  sample_count       INT NOT NULL,                -- how many owner classifications agreed
  total_observations INT NOT NULL,                -- total owner classifications for this brand
  last_observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT brand_classifications_learned_confidence_chk
    CHECK (confidence >= 0 AND confidence <= 1)
);

-- Lookup index for the cascade
CREATE INDEX IF NOT EXISTS brand_classifications_learned_lookup_idx
  ON public.brand_classifications_learned (brand);

-- Index for re-eval / decay sweeps
CREATE INDEX IF NOT EXISTS brand_classifications_learned_stale_idx
  ON public.brand_classifications_learned (last_observed_at);

COMMENT ON TABLE public.brand_classifications_learned IS
  'M138 — global brand → sub_category map populated reactively from owner sub_category overrides. Grows automatically; the cascade reads it as source=''brand_learned'' at confidence 0.85.';
COMMENT ON COLUMN public.brand_classifications_learned.confidence IS
  'Agreement ratio at last recompute: (count agreeing with chosen sub_category) / total_observations. We require >= 0.8 to add a row.';
COMMENT ON COLUMN public.brand_classifications_learned.sample_count IS
  'Number of owner-classified products that agree with the chosen sub_category. Required >= 3 to add a row.';

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.brand_classifications_learned_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brand_classifications_learned_touch_updated_at ON public.brand_classifications_learned;
CREATE TRIGGER brand_classifications_learned_touch_updated_at
  BEFORE UPDATE ON public.brand_classifications_learned
  FOR EACH ROW EXECUTE FUNCTION public.brand_classifications_learned_touch_updated_at();

-- Allow products.classification_source = 'brand_learned'. The
-- products_classification_source_chk constraint from M137 enumerated
-- only six sources; widen it so the cascade can write the new value.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_classification_source_chk') THEN
    ALTER TABLE products DROP CONSTRAINT products_classification_source_chk;
  END IF;
  ALTER TABLE products
    ADD CONSTRAINT products_classification_source_chk
    CHECK (classification_source IS NULL OR classification_source IN (
      'owner', 'supplier_articles', 'cross_customer', 'brand_learned',
      'openfoodfacts', 'web_llm', 'name_llm'
    ));
END $$;

COMMIT;
