-- M136 — products.volume_per_piece_ml + volume_per_piece_source
--
-- Symmetric to M122 (weight_per_piece_g) but for piece-priced LIQUIDS.
-- A "Thomas H Mystic Mango 20cl" bottle has volume 200 ml per piece;
-- a "Coca-Cola 33cl" has 330 ml. The cost engine's volume↔count bridge
-- needs this value to convert "recipe asks 60 ml" against
-- invoice_unit='st'.
--
-- Until the owner sets an explicit value, the cost engine falls back
-- to volumePerPieceMlFromName(name) — best-effort parse of "20cl" /
-- "33cl" / "75cl" tokens. This column is the manual-override layer
-- for products whose names lie or disclose nothing.
--
-- Source vocabulary (mirror of weight_per_piece_source):
--   'manual'           — owner set via EditItemModal
--   'supplier_article' — promoted from supplier_articles refined values
--                        (future M132-Phase-2 write-back hook)
--   'name_parsed'      — backfilled from a one-shot parse of product names
--   'ai_inferred'      — set by a future LLM classifier sweep
--   NULL               — never set; cost engine uses name-parse fallback
--
-- Idempotent. Safe to re-run.

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS volume_per_piece_ml     NUMERIC,
  ADD COLUMN IF NOT EXISTS volume_per_piece_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_volume_per_piece_ml_chk'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_volume_per_piece_ml_chk
      CHECK (volume_per_piece_ml IS NULL OR volume_per_piece_ml > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_volume_per_piece_source_chk'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_volume_per_piece_source_chk
      CHECK (volume_per_piece_source IS NULL OR volume_per_piece_source IN (
        'manual', 'supplier_article', 'name_parsed', 'ai_inferred'
      ));
  END IF;
END $$;

COMMENT ON COLUMN products.volume_per_piece_ml IS
  'M136 — Per-piece volume in ml for liquid bottles sold by st. Used by the cost engine''s volume↔count bridge for piece-priced liquids. NULL = use name-parse fallback.';
COMMENT ON COLUMN products.volume_per_piece_source IS
  'M136 — Provenance: manual / supplier_article / name_parsed / ai_inferred. Mirrors weight_per_piece_source.';

COMMIT;
