-- M089 — promote recipes to catalogue items
--
-- A prep recipe (tomato sauce, pizza dough, pesto) often lives as BOTH:
--   1. A cost calculation (raw products → cost per portion)
--   2. A physical thing on the shelf the owner counts during stocktake
--
-- This column threads option 2 to option 1. A row in `products` with
-- source_recipe_id != NULL is a "recipe-sourced product": its name +
-- price come from the linked recipe rather than from supplier invoices.
-- It appears in the catalogue + ingredient picker like any other
-- product, and (later) shows up on /inventory/counts as countable
-- stock.
--
-- Idempotent. Safe to re-run.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS source_recipe_id UUID
    REFERENCES recipes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS products_source_recipe_idx
  ON public.products (source_recipe_id)
  WHERE source_recipe_id IS NOT NULL;

-- The created_via enum gains a new value. Existing values stay valid.
-- (No formal CHECK constraint on created_via — it's a free-text tag.)
COMMENT ON COLUMN public.products.source_recipe_id IS
  'When non-null, this product is the catalogue representation of a recipe (prep item). Latest price = recipe.food_cost / recipe.portions. created_via = ''recipe_promotion''.';
