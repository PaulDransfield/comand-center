-- M121 — supplier_articles cross-customer catalogue
--
-- Indexed on (supplier_fortnox_number, article_number). Stores the
-- enrichment data scraped from supplier websites (Martin Servera
-- product pages now; later: Spendrups, Snabbgross, etc. or their
-- B2B APIs if they exist).
--
-- Why cross-customer: every customer who buys MS article 262899
-- (the Pommes frites super crunch) gets the same image + specs.
-- Scrape once, serve many.
--
-- Lookup path from a product:
--   product → product_aliases (article_number + supplier_fortnox_number)
--           → supplier_articles row → image + specs
--
-- Idempotent: ADD IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS public.supplier_articles (
  supplier_fortnox_number TEXT NOT NULL,
  article_number          TEXT NOT NULL,
  -- Provenance
  source                  TEXT NOT NULL,                 -- 'martinservera_scrape' | 'manual' | 'spendrups_api'
  fetched_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fetch_status            TEXT NOT NULL DEFAULT 'ok',    -- 'ok' | 'not_found' | 'error'
  fetch_error             TEXT,
  -- Core identification
  official_name           TEXT,
  description             TEXT,
  brand                   TEXT,
  category_path           TEXT,
  -- Image
  image_url               TEXT,                          -- the upstream URL we saw
  image_cached_path       TEXT,                          -- relative path in Supabase Storage if we self-host
  image_cached_at         TIMESTAMPTZ,
  -- Specifications (the Martin Servera "Specifikation" table you screenshotted)
  gtin                    TEXT,                          -- EAN-13 etc.
  brutto_weight_g         NUMERIC,                       -- brutto vikt in grams (10430 = 10,43 kg)
  net_weight_g            NUMERIC,                       -- netto vikt in grams
  unit                    TEXT,                          -- 'KRT' / 'STK' / 'KG' etc.
  units_per_pack          NUMERIC,                       -- 'antal/enhet' numeric component
  units_per_pack_label    TEXT,                          -- '10,00 kg/Kartong' as-written
  packs_per_master        NUMERIC,                       -- 'antal per hel förpackning' (4 cartons per pallet etc.)
  storage_type            TEXT,                          -- 'fryst' | 'kyl' | 'rum'
  country_origin          TEXT,                          -- 'Nederländerna'
  supplier_internal_sku   TEXT,                          -- 'Art.nr leverantör' (806704 in your example, the upstream supplier's own code)
  -- Free-form for everything else (egenskaper varies per category)
  properties              JSONB,
  -- Bookkeeping
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Primary key — one row per (supplier, article).
  PRIMARY KEY (supplier_fortnox_number, article_number)
);

COMMENT ON TABLE  public.supplier_articles IS
  'Cross-customer supplier catalogue: scraped product details (image, brand, GTIN, brutto/nettovikt, country, etc.) indexed by (supplier_fortnox_number, article_number). One row per real supplier SKU; every customer with a product_alias pointing at the same supplier+article gets the data.';

COMMENT ON COLUMN public.supplier_articles.image_cached_path IS
  'Relative path inside the Supabase Storage `supplier-article-images` bucket. NULL until first scrape successfully downloads the image. We self-host so upstream URL rotation does not break the UI.';

COMMENT ON COLUMN public.supplier_articles.properties IS
  'Catch-all JSONB for category-specific specs we did not model as columns (Bredd mm for frites, alcohol strength for beverages, IPA hops list, etc.).';

-- Useful query indexes.
-- (PK already covers the lookup-from-product path: WHERE supplier_fortnox_number = ? AND article_number = ?)
-- Add an index on source + fetch_status for re-scrape cron queries.
CREATE INDEX IF NOT EXISTS supplier_articles_fetch_status_idx
  ON public.supplier_articles (source, fetch_status, fetched_at);

-- And for stale-detection — "what hasn't been refreshed in 90 days".
CREATE INDEX IF NOT EXISTS supplier_articles_stale_idx
  ON public.supplier_articles (fetched_at)
  WHERE fetch_status = 'ok';

-- updated_at trigger so audits work.
CREATE OR REPLACE FUNCTION public.supplier_articles_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplier_articles_touch_updated_at ON public.supplier_articles;
CREATE TRIGGER supplier_articles_touch_updated_at
  BEFORE UPDATE ON public.supplier_articles
  FOR EACH ROW EXECUTE FUNCTION public.supplier_articles_touch_updated_at();

COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- Supabase Storage bucket (run separately via dashboard or SQL editor):
--
--   INSERT INTO storage.buckets (id, name, public)
--   VALUES ('supplier-article-images', 'supplier-article-images', true)
--   ON CONFLICT (id) DO NOTHING;
--
--   -- And RLS — read-public, write-service-role-only.
--   CREATE POLICY "Public read supplier-article-images"
--   ON storage.objects FOR SELECT
--   USING (bucket_id = 'supplier-article-images');
--
-- (Service role bypasses RLS so the scraper writes freely; reads
-- through the public CDN URL.)
