-- M157 — waste_log recipe + prep-waste columns
-- Status: ALREADY APPLIED 2026-06-12 (via the Supabase migration tool).
--   Here for the repo record. NOT idempotent on the constraints (ADD
--   CONSTRAINT has no IF NOT EXISTS) — only re-run on a DB that lacks them.
--
-- waste_log was product-only; the recipe + prep-waste features the app already
-- assumes (recipe waste, the per-dish "anything go in the bin?" prompt, cost
-- snapshot) need these columns. They were never applied to this DB, which is
-- why recipe/prep waste inserts failed and the recipe embed errored. The table
-- was EMPTY (0 rows) when this ran, so there were no orphans / nothing to migrate.

-- A row is now EITHER a product OR a recipe, so product_id must be nullable.
ALTER TABLE public.waste_log ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE public.waste_log
  ADD COLUMN IF NOT EXISTS recipe_id         uuid,
  ADD COLUMN IF NOT EXISTS cost_estimate_sek numeric,
  ADD COLUMN IF NOT EXISTS prep_session_id   uuid,
  ADD COLUMN IF NOT EXISTS archived_at       timestamptz;

-- recipe_id -> recipes. ON DELETE RESTRICT keeps waste history intact (recipes
-- are soft-deleted via archived_at, not hard-deleted); SET NULL would break the
-- XOR check below, since the row would then have neither product_id nor recipe_id.
ALTER TABLE public.waste_log
  ADD CONSTRAINT waste_log_recipe_id_fkey
    FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE RESTRICT;

-- prep_session_id -> prep_sessions. SET NULL is fine here (not part of the XOR);
-- a waste entry survives if its prep session is later removed.
ALTER TABLE public.waste_log
  ADD CONSTRAINT waste_log_prep_session_id_fkey
    FOREIGN KEY (prep_session_id) REFERENCES public.prep_sessions(id) ON DELETE SET NULL;

-- Exactly one of product_id / recipe_id per row (matches the code's `kind`).
ALTER TABLE public.waste_log
  ADD CONSTRAINT waste_log_product_xor_recipe
    CHECK ((product_id IS NOT NULL) <> (recipe_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS waste_log_recipe_id_idx       ON public.waste_log(recipe_id)       WHERE recipe_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS waste_log_prep_session_id_idx ON public.waste_log(prep_session_id) WHERE prep_session_id IS NOT NULL;
