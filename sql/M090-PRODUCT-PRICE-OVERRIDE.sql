-- M090 — products.price_override + price_override_currency
--
-- For recipe-sourced products (M089) or any product where the owner
-- wants to manually set a price that overrides the derived/observed
-- one. Useful when:
--   · Recipe-sourced product cost should reflect a fixed sale price
--     for stocktake purposes
--   · Owner knows the real market price better than the latest invoice
--     (supplier mis-billed, sale price changed, etc.)
--   · No invoice history exists yet (manually-added product)
--
-- When set, cost reader uses price_override × pack_size for line cost
-- INSTEAD OF the latest-line / recipe-derived price.
--
-- Idempotent. Safe to re-run.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS price_override            NUMERIC,
  ADD COLUMN IF NOT EXISTS price_override_currency   TEXT,
  ADD COLUMN IF NOT EXISTS price_override_set_at     TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_price_override_chk'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_price_override_chk
      CHECK (price_override IS NULL OR price_override >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_price_override_currency_chk'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_price_override_currency_chk
      CHECK (price_override_currency IS NULL OR price_override_currency IN ('SEK','EUR','USD','NOK','DKK','GBP'));
  END IF;
END $$;

COMMENT ON COLUMN public.products.price_override IS
  'Manual price override per invoice_unit. When non-null, cost reader uses this instead of latest_line/recipe-derived price. Currency in price_override_currency (default SEK).';
