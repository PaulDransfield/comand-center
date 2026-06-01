-- M117 — recipes.portions_per_cover
--
-- Adds a per-dish "mix share" so the prep list can auto-fill portion
-- counts from a single "expected covers" input. 0.15 means 15 % of
-- guests order this dish — for 200 covers we'd plan 30 of them.
--
-- WHY a fraction (0.0–10.0) instead of a percentage int?
--   The math is cleaner: qty = round(covers * share). UI translates to
--   percentage at the boundary (owner types "15", we store 0.15).
--
-- WHY upper bound 10?
--   No real dish is 1000% of covers. A 10× ceiling catches the
--   "owner typed 15 thinking percent but it stored as 15" typo (which
--   would otherwise predict 3,000 portions for 200 covers). UI should
--   feed values < 1 always.
--
-- NULL is fine — a dish without a share doesn't auto-fill. Owner adds
-- it manually or sets a share to opt in.

BEGIN;

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS portions_per_cover NUMERIC;

-- Add constraint only if it doesn't already exist (so re-running the
-- migration is safe).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recipes_portions_per_cover_range'
  ) THEN
    ALTER TABLE recipes
      ADD CONSTRAINT recipes_portions_per_cover_range
      CHECK (portions_per_cover IS NULL OR (portions_per_cover >= 0 AND portions_per_cover <= 10));
  END IF;
END$$;

COMMIT;
