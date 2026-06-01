-- M110 — products.default_waste_pct
--
-- Adds a per-product default yield-loss percentage. When the owner links
-- an article to a recipe ingredient via the edit-item modal, the recipe
-- ingredient's waste_pct auto-fills from the product's default. Still
-- per-line overridable at the recipe level — this is just a sensible
-- starting value so the same product costs consistently across dishes
-- without re-typing.
--
-- Bounds match recipe_ingredients.waste_pct (CHECK 0 <= x < 100) — same
-- shape so the auto-fill stays within the recipe-level constraint without
-- coercion, and the inflation formula quantity / (1 - waste_pct/100)
-- can't hit division-by-zero.
--
-- Additive, no destruction, safe on prod. Reversible by DROP COLUMN.
-- Existing rows default to 0 = no waste assumed (the conservative default
-- — owner sets explicitly when they know the real yield).

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS default_waste_pct numeric NOT NULL DEFAULT 0;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_default_waste_pct_chk;

ALTER TABLE products
  ADD CONSTRAINT products_default_waste_pct_chk
    CHECK (default_waste_pct >= 0 AND default_waste_pct < 100);

COMMIT;

-- Verification
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_name='products' AND column_name='default_waste_pct';
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='products'::regclass AND conname='products_default_waste_pct_chk';
