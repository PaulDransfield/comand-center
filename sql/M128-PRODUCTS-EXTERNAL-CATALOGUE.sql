-- M128 — link customer products to external supplier catalogues.
--
-- Some suppliers (Spendrups, Systembolaget) expose a structured product
-- catalogue on the public web that we scrape into supplier_articles
-- with a sentinel supplier_fortnox_number ('SPENDRUPS'). To wire this
-- enrichment into a customer's products without inventing their fnx
-- number we point at the upstream article directly with two columns
-- on products. The supplier-article batch lookup falls back through
-- these when the regular (fnx, article) join misses.

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS external_catalogue_source  TEXT,
  ADD COLUMN IF NOT EXISTS external_catalogue_article TEXT;

COMMENT ON COLUMN products.external_catalogue_source  IS
  'Sentinel for external catalogue link: ''SPENDRUPS'' / ''SYSTEMBOLAGET'' etc. NULL when no link.';
COMMENT ON COLUMN products.external_catalogue_article IS
  'Article number in the external catalogue. Joined with the sentinel against supplier_articles for thumbnail + spec enrichment.';

CREATE INDEX IF NOT EXISTS products_external_catalogue_idx
  ON products (external_catalogue_source, external_catalogue_article)
  WHERE external_catalogue_source IS NOT NULL;

COMMIT;
