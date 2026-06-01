-- M111 — Recipe yield (sub-recipe weight/volume per portion)
--
-- Lets a sub-recipe declare "1 portion = 250 g" (or ml/l/kg/st) so it
-- can be consumed in another recipe by weight/volume instead of being
-- forced into integer portions.
--
-- Without this column the engine has no way to convert
-- "30 g of Pinsa White Sauce" into a portion equivalent, so the
-- add-ingredient picker locks sub-recipe units to 'portion'.
--
-- Both columns are nullable — recipes without a yield set keep the
-- current behaviour (portion-only). When yield_amount IS set,
-- yield_unit MUST be too (and vice versa) — enforced via CHECK so
-- partial state never leaks through PATCH calls.

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS yield_amount numeric,
  ADD COLUMN IF NOT EXISTS yield_unit   text;

-- Drop + add CHECK so re-running this script is idempotent.
ALTER TABLE recipes DROP CONSTRAINT IF EXISTS recipes_yield_pair_chk;
ALTER TABLE recipes ADD CONSTRAINT recipes_yield_pair_chk
  CHECK (
    (yield_amount IS NULL AND yield_unit IS NULL)
    OR (yield_amount IS NOT NULL AND yield_amount > 0 AND yield_unit IS NOT NULL AND length(yield_unit) > 0)
  );

COMMENT ON COLUMN recipes.yield_amount IS
  'Weight/volume produced per portion. NULL = unknown; sub-recipe can only be consumed in portions.';
COMMENT ON COLUMN recipes.yield_unit IS
  'Unit of yield_amount. g/kg/ml/l/st etc. Engine converts via lib/inventory/unit-conversion.ts when a parent recipe consumes this sub-recipe in a different unit family.';
