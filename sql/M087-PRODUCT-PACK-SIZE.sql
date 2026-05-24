-- M087 — pack_size + base_unit on products
--
-- The whole point: recipes are written in grams / ml / pieces. Invoices
-- are per pack (1kg garlic bag, 4.1kg sauce tin, 30-piece egg tray).
-- Until now we silently assumed recipe.unit == product.invoice_unit,
-- which only worked when both were the same — usually wrong.
--
-- Example (the actual repro):
--   Vitlök Skalad 1kg Kl1 — bought as 1 ST @ 56 kr → 1 pack = 1000 g
--   Recipe uses 20 g of garlic.
--   Old calc: 20 × 56 = 1118 kr   ❌
--   New calc: 20 × (56 / 1000) = 1.12 kr   ✓
--
-- COLUMNS:
--   base_unit  TEXT  — what recipes use this product in. One of
--                      g, ml, st. Mass and volume are NOT interchangeable.
--   pack_size  NUMERIC — how many base_units in one invoice_unit
--                      (e.g. 1000 for a 1 kg bag where base_unit='g').
--
-- Both nullable: legacy products without pack data fall back to the old
-- 1:1 assumption + unit_mismatch warning so cost is wrong-but-visible
-- rather than silently nonsensical.
--
-- Auto-detection runs in code (lib/inventory/unit-conversion.ts) by
-- regexing the product name — "Pizza sauce Classica 4,1 kg" → 4100 g.
-- Detected values are SUGGESTED to the owner; saving is explicit.
--
-- Idempotent. Safe to re-run.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS pack_size NUMERIC,
  ADD COLUMN IF NOT EXISTS base_unit TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_base_unit_chk'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_base_unit_chk
      CHECK (base_unit IS NULL OR base_unit IN ('g', 'ml', 'st'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_pack_size_chk'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_pack_size_chk
      CHECK (pack_size IS NULL OR pack_size > 0);
  END IF;
END $$;
