-- sql/M132-GLOBAL-PRODUCT-ENRICHMENT.sql
--
-- Phase 1 of GLOBAL-PRODUCT-ENRICHMENT-PLAN.md (2026-06-05).
--
-- Goal: let customer A's owner-saved product refinements (weight per piece,
-- density, settled pack_size, settled category) flow back to a shared layer
-- so customer B inherits them on day 1.
--
-- Scope (Phase 1, SCHEMA ONLY — no app code yet):
--   1. Add `refined_*` columns to `supplier_articles` for the SHARE-safe
--      physical-truth attributes only (pack_size, base_unit, weight per
--      piece, density, category). PRICING, WASTE %, ALIASES, RECIPES
--      STAY PER-BUSINESS.
--   2. Track confidence (0=none, 1=single-customer, 2=verified-by-2+).
--   3. Create `supplier_article_refinement_log` for full audit + dispute
--      resolution + future promotion logic.
--   4. Add `share_refinements_with_platform` opt-out flag on `businesses`
--      (default TRUE — opt-out, not opt-in).
--
-- Apply order: extensions / table additions / log table / business flag.
-- Idempotent throughout — safe to re-run.

-- ── 1. Refinement columns on supplier_articles ───────────────────────
-- One row per (supplier, article) already; refinement values are the
-- consensus / promoted version visible at read time. Source of truth
-- for individual customer saves is the log table below.
ALTER TABLE supplier_articles
  ADD COLUMN IF NOT EXISTS refined_pack_size          numeric,
  ADD COLUMN IF NOT EXISTS refined_base_unit          text,
  ADD COLUMN IF NOT EXISTS refined_weight_per_piece_g numeric,
  ADD COLUMN IF NOT EXISTS refined_density_g_per_ml   numeric,
  ADD COLUMN IF NOT EXISTS refined_category           text,
  ADD COLUMN IF NOT EXISTS refined_confidence         smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refined_last_updated_at    timestamptz;

-- Sanity: confidence must be 0, 1, or 2.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_articles_refined_confidence_chk'
  ) THEN
    ALTER TABLE supplier_articles
      ADD CONSTRAINT supplier_articles_refined_confidence_chk
      CHECK (refined_confidence BETWEEN 0 AND 2);
  END IF;
END $$;

-- Category sanity: must match what `products.category` allows. Mirroring
-- the existing M083 / Phase B values for consistency. NULL is always OK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplier_articles_refined_category_chk'
  ) THEN
    ALTER TABLE supplier_articles
      ADD CONSTRAINT supplier_articles_refined_category_chk
      CHECK (refined_category IS NULL OR refined_category IN (
        'food', 'beverage', 'alcohol', 'cleaning', 'disposables',
        'packaging', 'equipment', 'other'
      ));
  END IF;
END $$;

-- ── 2. Refinement log — audit trail of every customer save ───────────
-- Captures: who saved what value when, against which (supplier, article).
-- Used by Phase 2 write-hook to compute confidence (count distinct
-- businesses saving the same value) and by admin dispute review.
--
-- Why a log not just UPDATE-in-place: we need to detect 2+-customer
-- agreement BEFORE promoting, and we need a defensible record if
-- two customers disagree (so we know whose value to trust).
CREATE TABLE IF NOT EXISTS supplier_article_refinement_log (
  id                       bigserial PRIMARY KEY,
  supplier_fortnox_number  text NOT NULL,
  article_number           text NOT NULL,
  business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  field                    text NOT NULL,
  value                    jsonb NOT NULL,
  set_at                   timestamptz NOT NULL DEFAULT now(),

  -- The (supplier, article) tuple matches supplier_articles' PK. FK keeps
  -- the log honest — can't log for an article we don't know about. ON
  -- DELETE CASCADE: if a supplier_article row is removed (rare — scraper
  -- prune), drop its history too.
  CONSTRAINT supplier_article_refinement_log_article_fk
    FOREIGN KEY (supplier_fortnox_number, article_number)
    REFERENCES supplier_articles (supplier_fortnox_number, article_number)
    ON DELETE CASCADE,

  -- Whitelist the fields we accept refinements for. Adding a new field
  -- to share later = touch this constraint + the refined_<field>
  -- column + the write hook (Phase 2). Keeping the list explicit
  -- prevents accidental writes of "name" or other per-business fields.
  CONSTRAINT supplier_article_refinement_log_field_chk
    CHECK (field IN ('pack_size', 'base_unit', 'weight_per_piece_g', 'density_g_per_ml', 'category'))
);

CREATE INDEX IF NOT EXISTS sarl_article_idx
  ON supplier_article_refinement_log (supplier_fortnox_number, article_number);

CREATE INDEX IF NOT EXISTS sarl_business_idx
  ON supplier_article_refinement_log (business_id);

CREATE INDEX IF NOT EXISTS sarl_field_idx
  ON supplier_article_refinement_log (field);

-- ── 3. Privacy opt-out flag on businesses ────────────────────────────
-- Default TRUE — opt-out semantics. Owner can flip via Settings to
-- exclude their business from both write-back (no contribution to
-- global) AND read-overlay (no acceptance of others' refinements).
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS share_refinements_with_platform boolean NOT NULL DEFAULT true;

-- ── 4. Optional sanity checks (read-only verification) ───────────────
-- Uncomment after applying to confirm the schema landed cleanly.
--
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'supplier_articles' AND column_name LIKE 'refined_%';
-- SELECT count(*) FROM supplier_article_refinement_log;
-- SELECT count(*) FILTER (WHERE share_refinements_with_platform) AS opted_in,
--        count(*) FILTER (WHERE NOT share_refinements_with_platform) AS opted_out
--   FROM businesses;
