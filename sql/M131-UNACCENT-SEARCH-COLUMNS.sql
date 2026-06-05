-- sql/M131-UNACCENT-SEARCH-COLUMNS.sql
--
-- Diacritic-insensitive search across the inventory surface.
--
-- Owner asked 2026-06-05: typing "é" should also match "e" everywhere we
-- search items (link article picker, items list, recipe search, Ask CC).
-- Postgres `ilike` is case-insensitive but NOT diacritic-insensitive —
-- stored "Crème" never matches a "Creme" query without help.
--
-- Approach:
--   1. Enable the `unaccent` extension (preinstalled in Supabase).
--   2. Wrap it in an IMMUTABLE function so it can drive generated columns
--      and (future) indexes. Plain `unaccent()` is STABLE which Postgres
--      forbids in generated columns.
--   3. Add `name_unaccent` to `products` and `raw_description_unaccent` to
--      `supplier_invoice_lines` — both lowercased + accent-stripped, kept
--      in sync automatically via STORED generated columns.
--   4. Application code searches against these columns after applying the
--      same NFD-strip in JS so query and data normalise the same way.
--
-- No data backfill needed — STORED generated columns populate on insert
-- AND on this ALTER (Postgres rewrites the table). Existing 10k+ rows
-- per business → ~seconds.

-- ── 1. Extension ──────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- ── 2. Immutable wrapper (required for GENERATED columns) ─────────────
CREATE OR REPLACE FUNCTION public.f_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  STRICT
  PARALLEL SAFE
AS $$
  SELECT extensions.unaccent('extensions.unaccent'::regdictionary, $1)
$$;

-- ── 3. products.name_unaccent ────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS name_unaccent text
  GENERATED ALWAYS AS (lower(public.f_unaccent(name))) STORED;

-- ── 4. supplier_invoice_lines.raw_description_unaccent ───────────────
ALTER TABLE supplier_invoice_lines
  ADD COLUMN IF NOT EXISTS raw_description_unaccent text
  GENERATED ALWAYS AS (lower(public.f_unaccent(raw_description))) STORED;

-- ── 5. Trigram indexes for fast %substring% ilike ────────────────────
-- pg_trgm is needed for gin_trgm_ops. Supabase has it; the CREATE is
-- idempotent so safe to re-run.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS products_name_unaccent_trgm_idx
  ON products USING gin (name_unaccent extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS sil_raw_desc_unaccent_trgm_idx
  ON supplier_invoice_lines USING gin (raw_description_unaccent extensions.gin_trgm_ops);

-- ── 6. Verify ────────────────────────────────────────────────────────
-- Smoke test: pick a row with a known accent and confirm the column resolved.
-- SELECT id, name, name_unaccent FROM products
--   WHERE name ~ '[éàèöäåÅÄÖ]' LIMIT 5;
