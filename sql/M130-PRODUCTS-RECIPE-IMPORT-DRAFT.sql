-- M130 — extend products.created_via CHECK to allow 'recipe_import_draft'.
--
-- New value for products created from recipe-text imports (AI recipe
-- bulk importer + manual recipe ingredient picker) where there is no
-- corresponding supplier_invoice_line at the time of creation. They're
-- "waiting for an invoice match" — the matcher will pair them when an
-- invoice arrives with the same (supplier, normalised_description, unit)
-- signature.
--
-- Why a new value:
--   The items API uses `created_via='recipe_promotion'` OR `source_recipe_id
--   IS NOT NULL` as the signal to SKIP the no_article/no_price/no_supplier
--   "Needs attention" flags. Recipe-import drafts deserve the same skip —
--   it's not actionable from the chef's side until an invoice lands.
--
-- Pure CHECK relaxation; no row rewrites. Companion backfill script
-- scripts/diag/backfill-recipe-import-drafts.mts converts existing
-- alias-less products to this new tag where appropriate.

BEGIN;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_created_via_chk;

ALTER TABLE products
  ADD CONSTRAINT products_created_via_chk CHECK (created_via IN (
    'auto_exact',
    'auto_fuzzy',
    'owner_review',
    'manual',
    'fortnox_backfill',
    'recipe_promotion',
    'recipe_import_draft'
  ));

COMMIT;
