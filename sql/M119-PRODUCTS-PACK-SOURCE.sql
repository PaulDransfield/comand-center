-- M119 — Pack-size resolver Phase A: add pack_source provenance column
--
-- Adds a nullable TEXT column to `products` that records WHERE the
-- pack_size + base_unit values came from:
--
--   - NULL                       legacy / unknown (pre-Phase A rows)
--   - 'name_parsed'              regex parsed "<num> <unit>" from the
--                                product name (e.g. "Pizza sauce 4,1 kg")
--   - 'invoice_unit_inferred'    deterministic dictionary inference from
--                                the supplier invoice unit (e.g.
--                                invoice_unit='KG' → pack_size=1000,
--                                base_unit='g'). Phase A addition.
--   - 'owner_set'                owner edited the value manually
--                                (reserved — wire from items PATCH UI
--                                when ready)
--   - 'ai_inferred'              Phase B (deferred) — LLM mop-up
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
--
-- This is metadata only — does NOT change pack_size or base_unit values
-- on existing rows. The Phase A backfill (POST
-- /api/inventory/items/backfill-pack-size) populates pack_source for the
-- products it touches.

BEGIN;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS pack_source TEXT;

COMMENT ON COLUMN public.products.pack_source IS
  'Provenance of pack_size + base_unit: name_parsed | invoice_unit_inferred | owner_set | ai_inferred. NULL = legacy / unknown. Set by the matcher at product creation, by the backfill cron, and (future) by the owner edit UI.';

-- Optional sanity index — pack_source = 'invoice_unit_inferred' may be
-- queried by future audits ("how many products did Phase A touch?").
-- Partial index keeps it cheap; only ~15 % of rows are non-NULL.
CREATE INDEX IF NOT EXISTS products_pack_source_idx
  ON public.products (business_id, pack_source)
  WHERE pack_source IS NOT NULL;

COMMIT;
