-- M139 — waste_log: extend M093 to support RECIPE-level waste
--
-- A2.1 (Push 1) — M093 shipped product-only waste tracking. To answer
-- "which DISH is leaking margin to waste" we also need to log waste
-- against a recipe (finished dish or sub-recipe). The prep-list
-- complete flow is the natural entry gate: chef ticks the rows that
-- didn't get used.
--
-- Schema changes (additive only — never break the existing surface):
--   1. product_id → make NULLABLE (was NOT NULL since M093)
--   2. + recipe_id     UUID nullable, FK recipes(id) ON DELETE SET NULL
--   3. + prep_session_id  UUID nullable, FK prep_sessions(id) ON DELETE SET NULL
--   4. + cost_estimate_sek NUMERIC nullable (alias for value_at_entry on the
--      recipe path; the existing /inventory/waste UI keeps using
--      value_at_entry for product rows). Engineering keeps both names
--      readable; the API writes whichever applies.
--   5. XOR CHECK: exactly one of product_id / recipe_id is set per row.
--   6. Broaden reason values to align with M139 plan:
--        keep:  spoilage | spill | over_portion | staff_meal | comp | other
--        add:   overproduction | customer_complaint | training | theft | spillage | spillage
--      'overproduction' is the prep-list default — historically wedged
--      into 'over_portion'; the new name is clearer for recipe-level rows.
--      'spillage' is a synonym for the existing 'spill' that I want
--      kept so chefs can pick either; both pass the CHECK.
--
-- All existing rows continue to validate. The /inventory/waste page
-- still works against the same table.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- 1. relax product_id NOT NULL
ALTER TABLE public.waste_log
  ALTER COLUMN product_id DROP NOT NULL;

-- 2. recipe_id
ALTER TABLE public.waste_log
  ADD COLUMN IF NOT EXISTS recipe_id UUID REFERENCES recipes(id) ON DELETE SET NULL;

-- 3. prep_session_id (M116)
ALTER TABLE public.waste_log
  ADD COLUMN IF NOT EXISTS prep_session_id UUID REFERENCES prep_sessions(id) ON DELETE SET NULL;

-- 4. cost_estimate_sek — semantic alias of value_at_entry but used by
-- the recipe-path API. Keep both to avoid breaking the existing
-- /inventory/waste write path that already writes value_at_entry.
ALTER TABLE public.waste_log
  ADD COLUMN IF NOT EXISTS cost_estimate_sek NUMERIC;

-- 5. XOR constraint — exactly one of recipe_id, product_id is set
-- (drop any prior version first so the migration is idempotent).
ALTER TABLE public.waste_log
  DROP CONSTRAINT IF EXISTS waste_log_target_xor;
ALTER TABLE public.waste_log
  ADD CONSTRAINT waste_log_target_xor CHECK (
    (recipe_id IS NOT NULL AND product_id IS NULL) OR
    (recipe_id IS NULL     AND product_id IS NOT NULL)
  );

-- 6. Reason values — drop the implicit OR add an explicit CHECK that
-- accepts both legacy + new vocabulary. The existing table has NO
-- reason CHECK constraint (just a TEXT NOT NULL column); adding one
-- here as a guard for the new write path.
ALTER TABLE public.waste_log
  DROP CONSTRAINT IF EXISTS waste_log_reason_chk;
ALTER TABLE public.waste_log
  ADD CONSTRAINT waste_log_reason_chk CHECK (reason IN (
    -- legacy (M093) names — kept so existing rows + UI keep working
    'spoilage', 'spill', 'over_portion', 'staff_meal', 'comp', 'other',
    -- new names introduced by M139 — synonyms preferred by the
    -- prep-list-complete form
    'overproduction', 'customer_complaint', 'training', 'theft', 'spillage'
  ));

-- Lookup index for the per-recipe rollup
CREATE INDEX IF NOT EXISTS waste_log_biz_recipe_idx
  ON public.waste_log (business_id, recipe_id, waste_date DESC)
  WHERE recipe_id IS NOT NULL;

-- Lookup index for the prep-session join (when surfacing waste back
-- to a specific session)
CREATE INDEX IF NOT EXISTS waste_log_prep_session_idx
  ON public.waste_log (prep_session_id)
  WHERE prep_session_id IS NOT NULL;

COMMENT ON COLUMN public.waste_log.recipe_id IS
  'M139 — recipe (dish or sub) that was wasted. XOR with product_id.';
COMMENT ON COLUMN public.waste_log.prep_session_id IS
  'M139 — optional link to the prep_sessions row where this waste was logged.';
COMMENT ON COLUMN public.waste_log.cost_estimate_sek IS
  'M139 — SEK cost at log time for recipe-path rows. value_at_entry continues to be used by the existing product-path API.';

COMMIT;
