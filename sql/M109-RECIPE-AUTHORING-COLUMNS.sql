-- M109 — Recipe authoring tool: additive columns
--
-- Adds the four columns the recipe-authoring tool needs:
--   recipes.selling_price_ex_vat  (primary stored truth — margin denominator)
--   recipes.vat_rate              (owner-set, independent of channel — 12/6/25)
--   recipes.channel               (dine_in | takeaway — does NOT determine rate)
--   recipe_ingredients.waste_pct  (per-line yield — engine math stays pure;
--                                  inflation done in loadRecipeIndex)
--
-- Design principles (per recipe-authoring-tool-prompt review):
--
--   1. VAT independence — vat_rate and channel are independently owner-set.
--      A dine-in pinsa is 12%, a takeaway pinsa is 6%, an alcoholic drink is
--      25% regardless of channel. NEVER infer rate from channel. This is the
--      same "VAT ↔ channel" coupling lesson from the VAT misrouting fix
--      (lib/sweden/vat.ts) — re-enforced at the schema level by making both
--      fields exist independently.
--
--   2. Single source of price truth — selling_price_ex_vat is the canonical
--      stored value. The existing menu_price (inc-VAT) is owner-facing
--      display only; on save it is derived from selling_price_ex_vat * (1 +
--      vat_rate/100). Owner UI accepts ex-VAT directly OR inc-VAT-as-
--      converter, but the stored truth is always ex-VAT. Existing rows with
--      menu_price set but no selling_price_ex_vat are left NULL — owner sets
--      explicitly on next edit (don't backfill — we can't infer their rate).
--
--   3. Waste bounds — CHECK (waste_pct >= 0 AND waste_pct < 100) prevents
--      division-by-zero in the loadRecipeIndex inflation formula
--      (quantity_for_cost = quantity / (1 - waste_pct/100)).
--
-- All additive. No data destruction. Safe to apply on live prod.
-- Reversible via DROP COLUMN if needed (existing recipes ignore the new
-- columns; engine reads with COALESCE-friendly defaults).

BEGIN;

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS selling_price_ex_vat numeric,
  ADD COLUMN IF NOT EXISTS vat_rate             numeric NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS channel              text    NOT NULL DEFAULT 'dine_in';

ALTER TABLE recipes
  DROP CONSTRAINT IF EXISTS recipes_vat_rate_chk,
  DROP CONSTRAINT IF EXISTS recipes_channel_chk;

ALTER TABLE recipes
  ADD CONSTRAINT recipes_vat_rate_chk CHECK (vat_rate >= 0 AND vat_rate <= 30),
  ADD CONSTRAINT recipes_channel_chk  CHECK (channel IN ('dine_in','takeaway'));

ALTER TABLE recipe_ingredients
  ADD COLUMN IF NOT EXISTS waste_pct numeric NOT NULL DEFAULT 0;

ALTER TABLE recipe_ingredients
  DROP CONSTRAINT IF EXISTS recipe_ingredients_waste_pct_chk;

ALTER TABLE recipe_ingredients
  ADD CONSTRAINT recipe_ingredients_waste_pct_chk
    CHECK (waste_pct >= 0 AND waste_pct < 100);

COMMIT;

-- Verification queries (run after the migration to sanity-check)
--
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_name='recipes'
--      AND column_name IN ('selling_price_ex_vat','vat_rate','channel')
--    ORDER BY column_name;
--
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_name='recipe_ingredients' AND column_name='waste_pct';
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='recipes'::regclass
--      AND conname IN ('recipes_vat_rate_chk','recipes_channel_chk');
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='recipe_ingredients'::regclass
--      AND conname='recipe_ingredients_waste_pct_chk';
