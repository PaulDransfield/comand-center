-- M093 — waste_log: manual waste tracking
--
-- Records what was thrown out / spilled / over-portioned so the
-- variance calc (later, when POS-recipe mapping ships) can subtract
-- waste from theoretical usage and get a true shrinkage number.
--
-- For MVP: pure manual input. Future: voice-to-row, photo-to-row,
-- POS integration for void/comp lines.
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.waste_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  org_id       UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  waste_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  quantity     NUMERIC NOT NULL CHECK (quantity > 0),
  unit         TEXT NOT NULL,                  -- owner-chosen unit at entry time

  -- Cost snapshot at entry (using cost reader's per-unit SEK price)
  unit_price_at_entry  NUMERIC,
  value_at_entry       NUMERIC,                -- qty (in base) × unit_price_at_entry / pack_size

  reason       TEXT NOT NULL,                  -- 'spoilage' | 'spill' | 'over_portion' | 'staff_meal' | 'comp' | 'other'
  notes        TEXT,

  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS waste_log_business_date_idx
  ON public.waste_log (business_id, waste_date DESC);

CREATE INDEX IF NOT EXISTS waste_log_product_idx
  ON public.waste_log (product_id);

ALTER TABLE public.waste_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS waste_log_org_isolation ON public.waste_log;
CREATE POLICY waste_log_org_isolation
  ON public.waste_log
  FOR ALL
  USING      (org_id = ANY (current_user_org_ids()))
  WITH CHECK (org_id = ANY (current_user_org_ids()));
