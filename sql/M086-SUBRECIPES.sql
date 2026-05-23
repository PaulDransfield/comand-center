-- M086 — sub-recipes (recipes-inside-recipes)
--
-- A dish is usually built from: raw products (mozzarella, basil) + several
-- prep recipes (pizza dough, tomato sauce, pesto). Until now an ingredient
-- could only point at a product; now it can point at another recipe too.
--
-- COST MODEL:
--   Sub-recipe yield unit = `portions` (already on recipes table).
--   Example: Tomato Sauce recipe yields 4 portions, total food_cost = 60 kr
--            → cost per portion = 15 kr
--   Margherita Pizza uses 0.5 portions of Tomato Sauce
--            → contributes 7.50 kr to the pizza's food_cost
--
--   Owner enters sub-recipe quantity in portions. UI shows the unit as
--   "portion(s) of <recipe name>".
--
-- CYCLES: A sub-recipe can't reference itself directly or transitively.
--   Prevention happens in two places:
--     1. POST /api/inventory/recipes/[id]/ingredients walks the proposed
--        sub-recipe's ingredient tree; if any descendant matches the
--        parent recipe id, returns 409 with a useful message.
--     2. lib/inventory/recipe-cost.ts cost computation tracks the
--        ancestor stack; if a cycle is detected at compute time anyway,
--        the offending ingredient gets line_cost = null + cycle flag and
--        the rest of the recipe still costs out.
--
-- Idempotent. Safe to re-run.

-- ── 1. Schema change ──────────────────────────────────────────────────
--
-- product_id was NOT NULL. Drop that, add subrecipe_id (nullable), and
-- enforce exactly-one-of via CHECK. RESTRICT on subrecipe delete so a
-- prep recipe can't be deleted while a dish references it.

ALTER TABLE public.recipe_ingredients
  ADD COLUMN IF NOT EXISTS subrecipe_id UUID REFERENCES recipes(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'recipe_ingredients'
       AND column_name  = 'product_id'
       AND is_nullable  = 'YES'
  ) THEN
    ALTER TABLE public.recipe_ingredients ALTER COLUMN product_id DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'recipe_ingredients_one_of_chk'
  ) THEN
    ALTER TABLE public.recipe_ingredients
      ADD CONSTRAINT recipe_ingredients_one_of_chk
      CHECK (
        (product_id IS NOT NULL AND subrecipe_id IS NULL) OR
        (product_id IS NULL     AND subrecipe_id IS NOT NULL)
      );
  END IF;
END $$;

-- Prevent self-reference at the DB level too (cheapest possible cycle).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'recipe_ingredients_no_self_ref_chk'
  ) THEN
    ALTER TABLE public.recipe_ingredients
      ADD CONSTRAINT recipe_ingredients_no_self_ref_chk
      CHECK (subrecipe_id IS NULL OR subrecipe_id != recipe_id);
  END IF;
END $$;

-- ── 2. Replace UNIQUE constraints ─────────────────────────────────────
--
-- Old constraint UNIQUE(recipe_id, product_id) doesn't cover sub-recipes.
-- Replace with two partial unique indexes so each (recipe, product) and
-- each (recipe, subrecipe) pair is still de-duped.
--
-- The old constraint can't be dropped if existing rows would violate the
-- new partial uniques (they won't — all existing rows have product_id
-- non-null, and (recipe_id, product_id) was already unique).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'recipe_ingredients_recipe_id_product_id_key'
  ) THEN
    ALTER TABLE public.recipe_ingredients
      DROP CONSTRAINT recipe_ingredients_recipe_id_product_id_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS recipe_ingredients_product_uniq
  ON public.recipe_ingredients (recipe_id, product_id)
  WHERE product_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS recipe_ingredients_subrecipe_uniq
  ON public.recipe_ingredients (recipe_id, subrecipe_id)
  WHERE subrecipe_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS recipe_ingredients_subrecipe_idx
  ON public.recipe_ingredients (subrecipe_id)
  WHERE subrecipe_id IS NOT NULL;
