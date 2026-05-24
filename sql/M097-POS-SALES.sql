-- M097 — POS menu items + sales (foundation for the variance loop)
--
-- Closes the inventory loop. We already have:
--   purchases  → supplier_invoice_lines (Fortnox)
--   waste      → waste_log
--   counts     → stock_count_lines (snapshots)
--   recipes    → recipes + recipe_ingredients + sub-recipes
--
-- This migration adds the missing piece: WHAT GOT SOLD on the POS,
-- mapped to recipes. With this in place we can compute:
--
--   theoretical_draw  = sum(pos_sales.quantity × recipe_ingredients.qty_in_base_unit)
--   actual_draw       = (last_count − this_count) + purchases − waste
--   shrinkage         = actual_draw − theoretical_draw   (positive = loss)
--
-- Two tables:
--
-- pos_menu_items
--   The owner's menu — one row per sellable dish. recipe_id links to
--   the costed recipe (one menu item ↔ one recipe for now; combos /
--   modifiers are phase 2 per POS-RECIPE-MAPPING-PLAN.md).
--   pos_provider='manual' for the manual-entry flow; future POS
--   connectors set 'caspeco' / 'onslip' / etc. and use pos_item_id to
--   sync incrementally.
--
-- pos_sales
--   One row per sale event. quantity = number sold. For manual entry
--   we collapse to weekly buckets (sold_at = Monday 00:00 of the week,
--   one row per dish per week); connectors will write per-ticket rows.
--   The variance calc doesn't care — it aggregates by date range.

BEGIN;

CREATE TABLE IF NOT EXISTS pos_menu_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id    UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  pos_provider   TEXT NOT NULL DEFAULT 'manual'
                       CHECK (pos_provider IN ('manual','caspeco','onslip','bonebar','inzii','personalkollen','other')),
  pos_item_id    TEXT,                                       -- provider's stable id; NULL for manual
  name           TEXT NOT NULL,
  recipe_id      UUID REFERENCES recipes(id) ON DELETE SET NULL,
  price_inc_vat  NUMERIC,                                    -- menu price (informational; recipe holds the source-of-truth menu price)
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One menu item per (business, provider, provider-item-id). For manual
-- entries (pos_item_id NULL) the constraint allows multiple — we
-- enforce uniqueness on name via a separate partial index below.
CREATE UNIQUE INDEX IF NOT EXISTS pos_menu_items_provider_uniq
  ON pos_menu_items (business_id, pos_provider, pos_item_id)
  WHERE pos_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pos_menu_items_manual_name_uniq
  ON pos_menu_items (business_id, LOWER(name))
  WHERE pos_provider = 'manual' AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS pos_menu_items_business_idx
  ON pos_menu_items (business_id, archived_at);

CREATE INDEX IF NOT EXISTS pos_menu_items_recipe_idx
  ON pos_menu_items (recipe_id) WHERE recipe_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pos_sales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id    UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  pos_item_id    UUID NOT NULL REFERENCES pos_menu_items(id) ON DELETE CASCADE,
  sold_at        TIMESTAMPTZ NOT NULL,                       -- per-ticket time; manual entry uses Monday-of-week 00:00 UTC
  -- Generated columns must be IMMUTABLE. `timestamptz::date` depends on
  -- the session's TimeZone GUC, so Postgres rejects it (42P17). Force
  -- UTC explicitly — manual-entry rows are already stored as UTC midnight,
  -- and connector writes should normalise to UTC at write time.
  sold_date      DATE GENERATED ALWAYS AS ((sold_at AT TIME ZONE 'UTC')::date) STORED,
  quantity       NUMERIC NOT NULL CHECK (quantity >= 0),     -- 0 is legal for "explicitly entered zero"
  net_revenue    NUMERIC,                                    -- optional — sum of (qty × price), VAT-excl
  source         TEXT NOT NULL DEFAULT 'manual'
                       CHECK (source IN ('manual','caspeco','onslip','bonebar','inzii','personalkollen','other')),
  source_ref     TEXT,                                       -- provider's ticket/order id (idempotency for connector writes)
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Connector writes idempotency: one row per (provider, ticket).
CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_source_ref_uniq
  ON pos_sales (business_id, source, source_ref)
  WHERE source_ref IS NOT NULL;

-- Manual weekly entries: one row per (item, week-start).
CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_manual_weekly_uniq
  ON pos_sales (business_id, pos_item_id, sold_date)
  WHERE source = 'manual';

CREATE INDEX IF NOT EXISTS pos_sales_business_date_idx
  ON pos_sales (business_id, sold_date DESC);

-- ───────────────────────────────────────────────────────────────────
-- RLS — same pattern as the rest of inventory (current_user_org_ids).

ALTER TABLE pos_menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_sales      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_menu_items_org_isolation ON pos_menu_items;
CREATE POLICY pos_menu_items_org_isolation ON pos_menu_items
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS pos_sales_org_isolation ON pos_sales;
CREATE POLICY pos_sales_org_isolation ON pos_sales
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

-- updated_at trigger (we already have set_updated_at() from earlier migrations)
CREATE TRIGGER pos_menu_items_set_updated_at
  BEFORE UPDATE ON pos_menu_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER pos_sales_set_updated_at
  BEFORE UPDATE ON pos_sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
