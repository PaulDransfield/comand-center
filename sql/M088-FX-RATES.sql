-- M088 — fx_rates table for daily currency conversion to SEK
--
-- Cost calc currently uses supplier_invoice_lines.price_per_unit
-- verbatim regardless of the line's currency. EUR/USD invoices land
-- in food cost with ~11x understatement (EUR cents read as SEK).
--
-- This table holds a daily SEK rate per supported currency. The cost
-- reader (lib/inventory/recipe-cost.ts) looks up the rate at the
-- line's invoice_date and multiplies through. If no rate exists for
-- that date (weekend, holiday, before our backfill window), it falls
-- back to the most recent rate <= invoice_date.
--
-- Source: ECB daily eurofxref XML feed (free, no API key needed,
-- updated 16:00 CET on TARGET2 business days). The daily cron at
-- /api/cron/fx-rates-update fetches and upserts.
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.fx_rates (
  id            BIGSERIAL PRIMARY KEY,
  rate_date     DATE NOT NULL,
  currency      TEXT NOT NULL,
  rate_to_sek   NUMERIC NOT NULL,    -- multiply <currency> amount by this to get SEK
  source        TEXT NOT NULL DEFAULT 'ecb',
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rate_date, currency, source)
);

CREATE INDEX IF NOT EXISTS fx_rates_lookup_idx
  ON public.fx_rates (currency, rate_date DESC);

-- SEK itself for convenience — always 1.0. Avoids special-casing the
-- reader for the trivial case.
INSERT INTO public.fx_rates (rate_date, currency, rate_to_sek, source)
SELECT CURRENT_DATE, 'SEK', 1.0, 'system'
WHERE NOT EXISTS (
  SELECT 1 FROM public.fx_rates WHERE currency = 'SEK' AND source = 'system'
);
