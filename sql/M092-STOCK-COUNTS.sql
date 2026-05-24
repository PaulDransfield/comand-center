-- M092 — stock_counts + stock_count_lines
--
-- Owner-led inventory count. Each count is a snapshot at a point in
-- time, optionally scoped to a location. Per-line:
--   · quantity + unit (owner can switch unit per row — kg/g/portion/st)
--   · unit_price_at_count = product's latest_price_sek at save time
--     (IMMUTABLE snapshot — re-opening an old count uses these prices)
--   · line_value_at_count = quantity_in_base_unit × unit_price_at_count
--   · The "current" value (what the count would be WORTH today) is
--     recomputed on read by joining to current product prices
--
-- Cost snapshot reasoning:
--   Old counts are an audit trail. If invoice prices change tomorrow,
--   the count from last week still has the SAME documented value it had
--   the day you closed it. The "current" value is a separate column
--   the API derives on read — useful for "what if I'd waited a week".
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.stock_counts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

  count_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  location_id   UUID REFERENCES stock_locations(id) ON DELETE SET NULL,
  notes         TEXT,

  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,           -- null = in-progress, set on submit
  archived_at   TIMESTAMPTZ,

  -- Snapshot totals computed at completion. Null while in-progress.
  total_value_at_count  NUMERIC,       -- sum of line_value_at_count
  total_lines           INTEGER,

  created_by    UUID,                  -- auth.users.id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_counts_business_idx
  ON public.stock_counts (business_id, count_date DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS stock_counts_completed_idx
  ON public.stock_counts (business_id, completed_at DESC NULLS LAST)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.stock_count_lines (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id               UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id             UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Counted quantity in the unit the owner chose (may differ from
  -- product.invoice_unit — e.g., counting a 5kg flour bag as 3.5kg).
  quantity               NUMERIC NOT NULL CHECK (quantity >= 0),
  unit                   TEXT NOT NULL,         -- 'kg' | 'g' | 'l' | 'ml' | 'st' | 'portion' | ...

  -- Immutable snapshot of the product's price-in-SEK per its invoice_unit
  -- at the moment this line was saved. Used so re-opening an old count
  -- shows the same value it had when completed.
  unit_price_at_count    NUMERIC,
  line_value_at_count    NUMERIC,               -- derived: qty × per-base-unit × unit_price_at_count
  pack_size_at_count     NUMERIC,               -- snapshot for value reconstruction
  base_unit_at_count     TEXT,
  invoice_unit_at_count  TEXT,

  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (count_id, product_id)
);

CREATE INDEX IF NOT EXISTS stock_count_lines_count_idx
  ON public.stock_count_lines (count_id);

CREATE INDEX IF NOT EXISTS stock_count_lines_product_idx
  ON public.stock_count_lines (product_id);

-- Touch updated_at on line edits so the parent count's "last edited"
-- view ranks correctly.
CREATE OR REPLACE FUNCTION public.stock_count_lines_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stock_count_lines_touch_trg ON public.stock_count_lines;
CREATE TRIGGER stock_count_lines_touch_trg
  BEFORE UPDATE ON public.stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION public.stock_count_lines_touch();

-- RLS
ALTER TABLE public.stock_counts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_count_lines  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_counts_org_isolation ON public.stock_counts;
CREATE POLICY stock_counts_org_isolation
  ON public.stock_counts
  FOR ALL
  USING      (org_id = ANY (current_user_org_ids()))
  WITH CHECK (org_id = ANY (current_user_org_ids()));

DROP POLICY IF EXISTS stock_count_lines_org_isolation ON public.stock_count_lines;
CREATE POLICY stock_count_lines_org_isolation
  ON public.stock_count_lines
  FOR ALL
  USING (
    count_id IN (SELECT id FROM stock_counts WHERE org_id = ANY (current_user_org_ids()))
  )
  WITH CHECK (
    count_id IN (SELECT id FROM stock_counts WHERE org_id = ANY (current_user_org_ids()))
  );
