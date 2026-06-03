-- M123 — extend products.created_via CHECK to allow 'recipe_promotion'.
--
-- The promote endpoint (/api/inventory/recipes/[id]/promote) has been
-- inserting products with created_via='recipe_promotion' since M089,
-- but M075's original CHECK constraint never listed that value. The
-- mismatch went undetected because no one promoted a recipe at a
-- business that still had the original constraint until 2026-06-03.
--
-- Failure mode: 23514 "new row for relation \"products\" violates
-- check constraint \"products_created_via_chk\"" on every promote attempt.
--
-- Safe to apply — pure CHECK relaxation, no row rewrites.

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
    'recipe_promotion'
  ));

COMMIT;
