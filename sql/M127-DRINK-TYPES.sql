-- M127 — drinks support for recipes.
--
-- Extends recipes.type to cover the drink categories on a typical
-- Italian restaurant menu. Wines also get a glass_price column —
-- bottles have dual pricing (per glass + per bottle) which need to
-- be tracked separately so margin computes for both pour modes.
--
-- Glass count derives from recipes.portions (default 6 = 125 ml per
-- 750 ml bottle = standard EU pour; owner can edit per-wine).

BEGIN;

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS glass_price NUMERIC;

COMMENT ON COLUMN recipes.glass_price IS
  'Wine glass-pour price (inc-VAT, kr). Only meaningful for type=''wine''. Bottle price goes in menu_price as usual. Glass cost = bottle_cost / portions.';

-- Type CHECK constraint — drop the old one if present, add a fresh
-- one that covers the new drink categories alongside the existing
-- food types. Idempotent: re-applying M127 is safe.
ALTER TABLE recipes
  DROP CONSTRAINT IF EXISTS recipes_type_chk;

ALTER TABLE recipes
  ADD CONSTRAINT recipes_type_chk CHECK (
    type IS NULL
    OR type IN (
      -- Food
      'starter', 'main', 'pasta', 'pizza', 'dessert', 'side', 'sauce', 'other',
      -- Drinks
      'cocktail', 'drink', 'wine', 'beer', 'spirit', 'softdrink', 'cider', 'alcohol_free'
    )
  );

COMMIT;
