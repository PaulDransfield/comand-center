-- M084 — recipes + recipe_ingredients
--
-- Real persistence for the recipe page (previously mock-only). Two
-- tables: recipes (header) + recipe_ingredients (line items linked to
-- products catalogue).
--
-- Cost calc lives in the API, not the DB — keeps the formula testable
-- and source-of-truth single (lib/inventory/recipe-cost.ts). DB stores
-- raw values; reader computes derived totals from
-- product.latest_price × ingredient.quantity.
--
-- UNIT MODEL (MVP):
--   ingredient.unit is stored verbatim (e.g. 'kg', 'g', 'l', 'st').
--   Cost calc assumes ingredient.unit == product.invoice_unit. When
--   mismatched, the reader still computes cost using quantity × latest
--   price but flags unit_mismatch=true so the UI can warn the owner.
--   Real unit conversion (5kg pack → 300g portion) is a follow-up — it
--   needs per-product 'pack_to_base_unit' factor on products table.
--
-- Idempotent. Safe to re-run.

-- ── 1. recipes ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recipes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

  name          TEXT NOT NULL,
  type          TEXT,            -- starter | main | pasta | pizza | dessert | drink | cocktail | side | sauce | other (free-text MVP, UI suggests)
  menu_price    NUMERIC,         -- SEK incl VAT (owner's discretion)
  portions      INTEGER NOT NULL DEFAULT 1,   -- how many portions the recipe yields (used by cost-per-portion calc)
  notes         TEXT,

  archived_at   TIMESTAMPTZ,     -- soft-delete; list endpoints filter IS NULL
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (business_id, name)     -- prevent silent duplicates
);

CREATE INDEX IF NOT EXISTS recipes_business_idx
  ON public.recipes (business_id)
  WHERE archived_at IS NULL;

-- ── 2. recipe_ingredients ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recipe_ingredients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id     UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
                -- RESTRICT, not CASCADE: deleting a product silently
                -- because it's in a recipe would corrupt cost history.
                -- Owner must explicitly remove from recipes first.

  quantity      NUMERIC NOT NULL CHECK (quantity > 0),
  unit          TEXT,            -- 'kg' | 'g' | 'l' | 'ml' | 'st' | 'dl' | 'cl' — stored verbatim
  notes         TEXT,            -- optional free-text per ingredient
  position      INTEGER NOT NULL DEFAULT 0,  -- display order

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (recipe_id, product_id) -- one row per (recipe, product) — add more quantity via PATCH not duplicate INSERT
);

CREATE INDEX IF NOT EXISTS recipe_ingredients_recipe_idx
  ON public.recipe_ingredients (recipe_id, position);

CREATE INDEX IF NOT EXISTS recipe_ingredients_product_idx
  ON public.recipe_ingredients (product_id);

-- ── 3. updated_at trigger on recipes ───────────────────────────────────
-- Touch updated_at on every UPDATE so the dashboard "recently changed"
-- sort works.
CREATE OR REPLACE FUNCTION public.recipes_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recipes_updated_at_trg ON public.recipes;
CREATE TRIGGER recipes_updated_at_trg
  BEFORE UPDATE ON public.recipes
  FOR EACH ROW
  EXECUTE FUNCTION public.recipes_touch_updated_at();

-- Bumping recipes.updated_at when ingredients change too — owner-facing
-- "last modified" should reflect ingredient edits not just header edits.
CREATE OR REPLACE FUNCTION public.recipe_ingredients_touch_parent()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.recipes SET updated_at = NOW()
   WHERE id = COALESCE(NEW.recipe_id, OLD.recipe_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recipe_ingredients_parent_touch_trg ON public.recipe_ingredients;
CREATE TRIGGER recipe_ingredients_parent_touch_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.recipe_ingredients
  FOR EACH ROW
  EXECUTE FUNCTION public.recipe_ingredients_touch_parent();

-- ── 4. RLS ─────────────────────────────────────────────────────────────
ALTER TABLE public.recipes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_ingredients  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recipes_org_isolation ON public.recipes;
CREATE POLICY recipes_org_isolation
  ON public.recipes
  FOR ALL
  USING      (org_id = ANY (current_user_org_ids()))
  WITH CHECK (org_id = ANY (current_user_org_ids()));

DROP POLICY IF EXISTS recipe_ingredients_org_isolation ON public.recipe_ingredients;
CREATE POLICY recipe_ingredients_org_isolation
  ON public.recipe_ingredients
  FOR ALL
  USING (
    recipe_id IN (SELECT id FROM recipes WHERE org_id = ANY (current_user_org_ids()))
  )
  WITH CHECK (
    recipe_id IN (SELECT id FROM recipes WHERE org_id = ANY (current_user_org_ids()))
  );
