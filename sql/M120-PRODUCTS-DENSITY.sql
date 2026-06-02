-- M120 — products.density_g_per_ml + density_source
--
-- Lets the cost engine convert recipe quantities across mass↔volume
-- when a recipe asks for "30 g of olive oil" but the supplier sells it
-- as a 5 L bottle (base_unit='ml'). Without density, the engine has
-- to flag unit-mismatch and refuse to compute. With density:
--    recipe_ml = recipe_g / density_g_per_ml
--    cost     = recipe_ml × cost_per_ml
--
-- density_source tracks provenance:
--   NULL                  legacy / unknown
--   'manual'              owner edited via the items detail UI
--   'ai_inferred'         Haiku classified the product class and
--                         applied the convention density
--   'convention_default'  deterministic fallback (e.g. category=alcohol
--                         + unit=ml → 0.95) — reserved for future
--
-- Conservative numeric scale: NUMERIC(6,4) covers 0.0001..99.9999 which
-- is way more range than any cooking ingredient needs (densest food
-- materials around 1.5 g/ml; densest liquids like mercury would still
-- fit if we ever cared).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS density_g_per_ml NUMERIC(6,4),
  ADD COLUMN IF NOT EXISTS density_source   TEXT;

-- Defence-in-depth: refuse impossible densities. Cooking ingredients
-- range from about 0.5 (very fluffy whipped cream) to 1.5 (concentrated
-- syrups/honey). Keep room for outliers like brines (~1.2) without
-- accepting clearly-wrong values.
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_density_g_per_ml_check,
  ADD  CONSTRAINT       products_density_g_per_ml_check
       CHECK (density_g_per_ml IS NULL OR (density_g_per_ml > 0 AND density_g_per_ml <= 5));

COMMENT ON COLUMN public.products.density_g_per_ml IS
  'Density in grams per millilitre. Lets the cost engine convert recipe units across mass<->volume (e.g. 30 g of olive oil → 33 ml at 0.91 g/ml). NULL = unknown, engine surfaces unit_mismatch.';

COMMENT ON COLUMN public.products.density_source IS
  'Provenance of density_g_per_ml: manual | ai_inferred | convention_default. NULL = legacy / unknown.';

-- Partial index for audits ("which products did the AI infer?").
CREATE INDEX IF NOT EXISTS products_density_source_idx
  ON public.products (business_id, density_source)
  WHERE density_source IS NOT NULL;

COMMIT;
