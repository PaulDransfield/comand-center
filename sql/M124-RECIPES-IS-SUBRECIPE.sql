-- M124 — explicit recipes.is_subrecipe boolean.
--
-- Until now, "is this recipe a sub-recipe?" was INFERRED from
--   (no menu_price OR menu_price=0) AND type NOT IN (DISH_TYPES).
-- That fails for items like "Classic Tiramisu Whole Tray" — type=dessert
-- with no menu_price (the tray itself isn't sold whole). Owner wants to
-- consume it as a sub-recipe in plated-dessert recipes, but the inference
-- locks it to the Dishes filter.
--
-- New column lets owner override the inference explicitly. NULL/FALSE
-- = use the existing inference (backwards-compatible). TRUE = treat as
-- sub-recipe regardless of type / price.
--
-- The bulk importer's draft-level is_subrecipe flag (page.tsx) now
-- persists straight into this column.

BEGIN;

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS is_subrecipe BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN recipes.is_subrecipe IS
  'Explicit owner-toggle: TRUE = treat as sub-recipe in lists / ingredient picker / margin views regardless of type or price. FALSE = use the legacy inference (no price + non-dish-type).';

COMMIT;
