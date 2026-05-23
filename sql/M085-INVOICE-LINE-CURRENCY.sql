-- M085 — currency tracking on supplier_invoice_lines
--
-- Until now we silently assumed every invoice was in SEK. Some
-- suppliers invoice in EUR (or NOK/DKK/USD/GBP for cross-border
-- suppliers). Treating EUR amounts as SEK silently inflates food
-- cost by ~11x in recipe calc — owner-fatal data quality bug.
--
-- This column captures what the invoice currency actually was. Default
-- is 'SEK' so existing rows behave unchanged. The PDF extractor will
-- be updated to detect currency from the invoice header (€, $, kr,
-- explicit currency line) and write the correct value going forward.
--
-- FX CONVERSION TO SEK is a follow-up — cost readers still use
-- price_per_unit verbatim. When a non-SEK row exists, the UI warns
-- the owner that recipe cost / catalogue price comparisons may be
-- misleading until FX conversion ships.
--
-- Idempotent. Safe to re-run.

ALTER TABLE public.supplier_invoice_lines
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'SEK';

-- ISO 4217 codes for the currencies a Swedish restaurant might encounter
-- in supplier invoices. Add new codes here if needed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'supplier_invoice_lines_currency_chk'
  ) THEN
    ALTER TABLE public.supplier_invoice_lines
      ADD CONSTRAINT supplier_invoice_lines_currency_chk
      CHECK (currency IN ('SEK','EUR','USD','NOK','DKK','GBP'));
  END IF;
END $$;

-- Index for "show me all EUR lines this month" kind of queries.
CREATE INDEX IF NOT EXISTS supplier_invoice_lines_currency_idx
  ON public.supplier_invoice_lines (business_id, currency)
  WHERE currency != 'SEK';
