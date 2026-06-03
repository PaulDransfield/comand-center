-- M122 — products.weight_per_piece_g + weight_per_piece_source
--
-- Lets the cost engine convert recipe quantities across mass↔count
-- when a recipe asks for "30 g of egg" but the supplier sells eggs as
-- a 120-piece carton (base_unit='st'). Without weight_per_piece, the
-- engine has to flag unit-mismatch and refuse to compute. With it:
--    pieces_needed = recipe_g / weight_per_piece_g
--    cost          = pieces_needed × (unit_price / pack_size)
--
-- Mirrors the M120 density pattern. Source attribution lets us audit
-- where the number came from and trust manual > scraped > inferred.
--
--   NULL                  legacy / unknown
--   'manual'              owner edited via the items detail UI
--   'supplier_article'    derived from supplier_articles.net_weight_g /
--                         products.pack_size for count-based products
--   'name_parsed'         parsed from product name like "Egg 60g"
--
-- Scale: NUMERIC(8,3) handles 0.001 g (microspice grains) up to
-- 99999.999 g (giant container goods). Restaurant pieces realistically
-- span ~0.1 g (cardamom pod) up to ~5000 g (whole leg of lamb), well
-- within bounds.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS weight_per_piece_g       NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS weight_per_piece_source  TEXT;

-- Defence-in-depth: must be positive. Upper bound generous; a Christmas
-- ham can easily weigh 8 kg per piece.
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_weight_per_piece_g_check,
  ADD  CONSTRAINT       products_weight_per_piece_g_check
       CHECK (weight_per_piece_g IS NULL OR (weight_per_piece_g > 0 AND weight_per_piece_g <= 100000));

COMMENT ON COLUMN public.products.weight_per_piece_g IS
  'Grams per single piece for count-based products. Lets the cost engine convert recipe units across mass<->count (e.g. 30 g of egg → 0.5 pieces at 60 g/piece). NULL = unknown, engine surfaces unit_mismatch.';

COMMENT ON COLUMN public.products.weight_per_piece_source IS
  'Provenance of weight_per_piece_g: manual | supplier_article | name_parsed. NULL = legacy / unknown.';

-- Partial index for audits ("which products inherited from a supplier article?").
CREATE INDEX IF NOT EXISTS products_weight_per_piece_source_idx
  ON public.products (business_id, weight_per_piece_source)
  WHERE weight_per_piece_source IS NOT NULL;

COMMIT;
