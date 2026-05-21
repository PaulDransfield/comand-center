-- M075 — Inventory catalogue: products / product_aliases / supplier_invoice_lines
--
-- Phase A of INVENTORY-CATALOGUE-PLAN.md. Persists every Fortnox supplier-
-- invoice line into an auditable table, threads each line to a canonical
-- product row via a deduplication alias layer.
--
-- THE PRIME DIRECTIVE (do not relax these constraints in a future migration):
--   One real-world product = exactly one row in `products`. Forever.
--   The two unique indexes on `product_aliases` are what make duplicate
--   prevention structural. Removing either = duplicates can happen.
--
-- DEVIATION FROM PLAN: no local `suppliers` cache table. Suppliers are
-- identified by Fortnox `SupplierNumber` (TEXT) directly. Name is captured
-- as a denormalised snapshot per line so the UI doesn't have to join out
-- to a live Fortnox fetch for display.
--
-- Idempotent. Safe to re-run; each CREATE has IF NOT EXISTS or equivalent.
--
-- Rollback: drop tables in reverse FK order; drop pg_trgm only if no other
-- consumer (verify with `\dx` first).

-- ═══════════════════════════════════════════════════════════════════════
-- 1. pg_trgm extension (for fuzzy description matching, steps 3-4 of the
--    matching ladder in INVENTORY-CATALOGUE-PLAN.md §3)
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. products — canonical catalogue. ONE row per real-world thing.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.products (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Owner-curated display name. Defaults to a cleaned-up first-seen
  -- alias description; owner can rename without breaking history.
  name                  TEXT NOT NULL,

  -- 'food' | 'beverage' | 'alcohol' | 'cleaning' | 'takeaway_material' |
  -- 'disposables' | 'other'. First-pass = BAS account → category map.
  category              TEXT NOT NULL,
  category_overridden   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Unit the owner wants to count in. Often differs from the invoice unit
  -- ("bottles" vs "L"). Phase C feature; nullable for now.
  count_unit            TEXT,
  invoice_unit          TEXT,                  -- most-common unit seen on invoices
  unit_conversion       NUMERIC,               -- 1 count_unit = X invoice_unit

  -- The supplier we usually buy this from. Fortnox SupplierNumber, no FK.
  default_supplier_fortnox_number TEXT,
  default_supplier_name           TEXT,

  created_via           TEXT NOT NULL,         -- 'auto_exact' | 'auto_fuzzy' | 'owner_review' | 'manual'
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Soft delete only — preserves history.
  archived_at           TIMESTAMPTZ,

  CONSTRAINT products_category_chk CHECK (category IN (
    'food', 'beverage', 'alcohol', 'cleaning',
    'takeaway_material', 'disposables', 'other'
  )),
  CONSTRAINT products_created_via_chk CHECK (created_via IN (
    'auto_exact', 'auto_fuzzy', 'owner_review', 'manual', 'fortnox_backfill'
  )),

  UNIQUE (business_id, name)
);

CREATE INDEX IF NOT EXISTS products_business_idx
  ON public.products (business_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS products_category_idx
  ON public.products (business_id, category)
  WHERE archived_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. product_aliases — every spelling / article number ever seen.
--    THIS TABLE IS THE DEDUP UNLOCK. The two unique indexes below are
--    the load-bearing constraints; do not remove them.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.product_aliases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id            UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  supplier_fortnox_number TEXT NOT NULL,
  supplier_name_snapshot  TEXT,

  -- Fortnox structured data when available — gold-standard match key.
  article_number        TEXT,

  -- Free-text description as seen on the invoice. Verbatim.
  raw_description       TEXT NOT NULL,

  -- Lowercased, ASCII-folded, punctuation-stripped. Computed in app
  -- code (lib/inventory/normalise.ts) so the function is unit-testable
  -- and identical for ingestion + the UI search box.
  normalised_description TEXT NOT NULL,

  unit                  TEXT,
  match_method          TEXT NOT NULL,         -- 'article_number' | 'description_exact' | 'fuzzy_same_supplier' | 'fuzzy_cross_supplier' | 'owner_confirmed'
  match_confidence      NUMERIC,               -- 0..1; NULL for exact matches

  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count            INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT product_aliases_match_method_chk CHECK (match_method IN (
    'article_number', 'description_exact',
    'fuzzy_same_supplier', 'fuzzy_cross_supplier',
    'owner_confirmed'
  ))
);

-- THE TWO LOAD-BEARING UNIQUE CONSTRAINTS — these prevent duplicates
-- structurally. Removing either = the matcher can no longer rely on
-- INSERT … ON CONFLICT for idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS product_aliases_article_uniq
  ON public.product_aliases (business_id, supplier_fortnox_number, article_number)
  WHERE article_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_aliases_desc_uniq
  ON public.product_aliases (business_id, supplier_fortnox_number, normalised_description, COALESCE(unit, ''))
  WHERE article_number IS NULL;

-- Trigram GIN index for the fuzzy matcher (ladder steps 3 + 4).
CREATE INDEX IF NOT EXISTS product_aliases_desc_trgm_idx
  ON public.product_aliases USING gin (normalised_description gin_trgm_ops);

-- Helper index for "all aliases for product X" lookups (merges/splits, UI).
CREATE INDEX IF NOT EXISTS product_aliases_product_idx
  ON public.product_aliases (product_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 4. supplier_invoice_lines — raw audit trail. Every line ever pulled,
--    never mutated after insert. Owner never reads this directly; they
--    always see joined `products` data.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.supplier_invoice_lines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  supplier_fortnox_number TEXT NOT NULL,
  supplier_name_snapshot  TEXT,

  -- Fortnox invoice key — links the line back to the invoice header.
  -- `GivenNumber` is the Fortnox-side display number, stable per invoice.
  fortnox_invoice_number  TEXT NOT NULL,
  invoice_date            DATE NOT NULL,
  invoice_period_year     INTEGER NOT NULL,
  invoice_period_month    INTEGER NOT NULL,

  -- 1-based row index inside the invoice. Together with the invoice
  -- number this makes the line uniquely identifiable for idempotent
  -- re-runs of the backfill.
  row_number              INTEGER NOT NULL,

  -- Raw Fortnox fields — captured verbatim, never mutated.
  raw_description         TEXT NOT NULL,
  article_number          TEXT,
  quantity                NUMERIC,
  unit                    TEXT,
  price_per_unit          NUMERIC,
  total_excl_vat          NUMERIC NOT NULL,
  vat_rate                NUMERIC,
  account_number          TEXT,                  -- BAS account from SupplierInvoiceRow.AccountNumber

  -- Bridge to catalogue. NULL = sitting in the review queue.
  product_alias_id        UUID REFERENCES product_aliases(id) ON DELETE SET NULL,

  -- Matcher state machine.
  match_status            TEXT NOT NULL,         -- 'matched' | 'needs_review' | 'skipped' | 'not_inventory'

  -- Top-3 trigram candidates from the matcher, for the review UI to
  -- show "Looks similar to: …". Set even when match succeeded so we
  -- have an audit trail of what alternatives were considered.
  match_candidates        JSONB,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_at              TIMESTAMPTZ,

  CONSTRAINT supplier_invoice_lines_match_status_chk CHECK (match_status IN (
    'matched', 'needs_review', 'skipped', 'not_inventory'
  )),

  -- Idempotency key for the backfill worker. Re-running a backfill on
  -- an already-ingested invoice is a no-op via ON CONFLICT DO NOTHING.
  UNIQUE (business_id, fortnox_invoice_number, row_number)
);

CREATE INDEX IF NOT EXISTS supplier_invoice_lines_supplier_idx
  ON public.supplier_invoice_lines (business_id, supplier_fortnox_number, invoice_date DESC);

CREATE INDEX IF NOT EXISTS supplier_invoice_lines_review_idx
  ON public.supplier_invoice_lines (business_id, match_status, created_at DESC)
  WHERE match_status = 'needs_review';

CREATE INDEX IF NOT EXISTS supplier_invoice_lines_product_idx
  ON public.supplier_invoice_lines (product_alias_id)
  WHERE product_alias_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS supplier_invoice_lines_period_idx
  ON public.supplier_invoice_lines (business_id, invoice_period_year, invoice_period_month);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. RLS — same pattern as M018 multi-tenant isolation
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.products              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_aliases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_invoice_lines ENABLE ROW LEVEL SECURITY;

-- products: members of org_id see their own org's rows
DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS products_modify ON public.products;
CREATE POLICY products_modify ON public.products
  FOR ALL USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

-- product_aliases: inherit via products.business_id
DROP POLICY IF EXISTS product_aliases_select ON public.product_aliases;
CREATE POLICY product_aliases_select ON public.product_aliases
  FOR SELECT USING (
    business_id IN (
      SELECT b.id FROM public.businesses b
      WHERE b.org_id IN (SELECT current_user_org_ids())
    )
  );

DROP POLICY IF EXISTS product_aliases_modify ON public.product_aliases;
CREATE POLICY product_aliases_modify ON public.product_aliases
  FOR ALL USING (
    business_id IN (
      SELECT b.id FROM public.businesses b
      WHERE b.org_id IN (SELECT current_user_org_ids())
    )
  )
  WITH CHECK (
    business_id IN (
      SELECT b.id FROM public.businesses b
      WHERE b.org_id IN (SELECT current_user_org_ids())
    )
  );

-- supplier_invoice_lines: same as products
DROP POLICY IF EXISTS supplier_invoice_lines_select ON public.supplier_invoice_lines;
CREATE POLICY supplier_invoice_lines_select ON public.supplier_invoice_lines
  FOR SELECT USING (org_id IN (SELECT current_user_org_ids()));

DROP POLICY IF EXISTS supplier_invoice_lines_modify ON public.supplier_invoice_lines;
CREATE POLICY supplier_invoice_lines_modify ON public.supplier_invoice_lines
  FOR ALL USING (org_id IN (SELECT current_user_org_ids()))
  WITH CHECK (org_id IN (SELECT current_user_org_ids()));

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Helper RPCs called from lib/inventory/matcher.ts
-- ═══════════════════════════════════════════════════════════════════════

-- Trigram candidate search. Returns top-N aliases ranked by similarity
-- to the input query, joined to product names for the review UI.
--
-- The matcher decides same-vs-cross-supplier branching in JS using the
-- supplier_fortnox_number column we return, so a single call covers
-- both step 3 and step 4 of the ladder.
CREATE OR REPLACE FUNCTION public.inventory_trigram_search(
  p_business_id UUID,
  p_query       TEXT,
  p_limit       INTEGER DEFAULT 12
)
RETURNS TABLE (
  alias_id                UUID,
  product_id              UUID,
  product_name            TEXT,
  raw_description         TEXT,
  supplier_fortnox_number TEXT,
  similarity              REAL
)
LANGUAGE sql STABLE AS $$
  SELECT
    pa.id                            AS alias_id,
    pa.product_id                    AS product_id,
    p.name                           AS product_name,
    pa.raw_description               AS raw_description,
    pa.supplier_fortnox_number       AS supplier_fortnox_number,
    similarity(pa.normalised_description, p_query) AS similarity
  FROM public.product_aliases pa
  JOIN public.products p ON p.id = pa.product_id AND p.archived_at IS NULL
  WHERE pa.business_id = p_business_id
    AND pa.normalised_description % p_query   -- trigram %% operator → uses GIN
  ORDER BY pa.normalised_description <-> p_query
  LIMIT p_limit
$$;

-- Atomic last_seen_at + seen_count bump for exact (step 1 / step 2) hits.
-- Avoids a SELECT-then-UPDATE round trip and races between concurrent
-- matchers on the same alias.
CREATE OR REPLACE FUNCTION public.inventory_touch_alias(
  p_alias_id UUID
)
RETURNS VOID
LANGUAGE sql AS $$
  UPDATE public.product_aliases
     SET last_seen_at = NOW(),
         seen_count   = seen_count + 1
   WHERE id = p_alias_id
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. updated_at trigger for products (Phase B will need this for merges)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.set_products_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON public.products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.set_products_updated_at();
