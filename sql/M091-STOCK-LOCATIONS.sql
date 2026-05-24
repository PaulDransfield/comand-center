-- M091 — stock_locations: per-business count locations
--
-- Some businesses want to count walk-in / dry store / bar separately
-- (so the kitchen lead can split the work). Others count everything
-- as one. This table is OPTIONAL: stock_counts can have a location_id
-- or be NULL (meaning "single global count").
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.stock_locations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  org_id       UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, name)
);

CREATE INDEX IF NOT EXISTS stock_locations_business_idx
  ON public.stock_locations (business_id, sort_order)
  WHERE archived_at IS NULL;

-- RLS
ALTER TABLE public.stock_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_locations_org_isolation ON public.stock_locations;
CREATE POLICY stock_locations_org_isolation
  ON public.stock_locations
  FOR ALL
  USING      (org_id = ANY (current_user_org_ids()))
  WITH CHECK (org_id = ANY (current_user_org_ids()));
