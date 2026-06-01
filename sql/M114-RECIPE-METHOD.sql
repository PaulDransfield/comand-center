-- M114 — Recipe method (cooking instructions)
--
-- Adds a free-form text column for the chef's method / cooking
-- instructions. Many imported Word documents carry the method
-- alongside the ingredient list — the AI bulk importer extracts it
-- + populates this column; the recipe drawer surfaces it as an
-- editable textarea.
--
-- Pure text, no structure constraint. Up to ~8000 chars in practice
-- (a typical pasta recipe method is 500-2000 chars).

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS method text;

COMMENT ON COLUMN recipes.method IS
  'Free-form cooking method / preparation instructions. Owner-edited or AI-imported from menu/Word documents. Not used in cost or margin calculations.';
