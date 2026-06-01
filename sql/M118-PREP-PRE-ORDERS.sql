-- M118 — prep_pre_orders (advance customer commitments)
--
-- Owner-driven advance bookings where the customer has already
-- specified what they want. "Sara's birthday — table of 8, ordering
-- 4 Margherita + 2 Pinsa Parma + 2 Carpaccio." Owner enters these the
-- day before; prep list folds them into the production for that
-- service_date so the kitchen knows what's already committed AND can
-- order ingredients accordingly.
--
-- ── Design rationale ──────────────────────────────────────────────────
--
-- WHY ON THE BUSINESS (not on a session)?
--   Pre-orders are known days/weeks ahead. They exist independently
--   of any prep session. A given service date might or might not
--   have a prep session created yet — when the chef creates one,
--   that day's pre-orders fold in automatically.
--
-- WHY items AS JSONB?
--   Variable-length per pre-order (one dish vs ten). Recipe_id refs
--   are first-class (we can validate them against the business's
--   recipes at write time). Joining on a child table for "show me
--   pre-order qtys for dish X across all bookings tomorrow" is
--   cheap with a GIN index on the JSONB column if we ever need it.
--
-- WHY service_date AS A DATE (not timestamptz)?
--   Restaurant prep is day-bounded. Lunch vs dinner is a future
--   refinement (column `service_slot`); v1 is per-date.
--
-- WHY archived_at AND NOT hard delete?
--   Cancellations happen, and the owner may want to see the audit
--   later ("we prepped for this and it cancelled day-of"). Soft
--   delete preserves the history without polluting the active list.

BEGIN;

CREATE TABLE IF NOT EXISTS prep_pre_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id   UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  service_date  DATE NOT NULL,
  -- Optional human label — "Sara's birthday", "Carlsson party",
  -- "Walk-in pre-order #4". Helps the owner recognise their entries
  -- in the list; the prep list itself doesn't use it for math.
  party_name    TEXT,
  -- Number of covers in this party. Counted into total covers when
  -- the owner runs the share-based auto-fill: covers - sum(party_size)
  -- of pre-orders = "free" covers distributed by mix share.
  party_size    INTEGER NOT NULL CHECK (party_size > 0),
  notes         TEXT,
  -- [{ recipe_id, qty }, ...]. Recipe ids validated by the API at
  -- write time (must belong to the business + be a non-archived
  -- recipe). Qty is whole portions (the kitchen prepares discrete
  -- units).
  items         JSONB NOT NULL DEFAULT '[]'::jsonb
                  CHECK (jsonb_typeof(items) = 'array'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID,                                       -- auth.users id; soft (no FK to avoid cascade pain)
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at   TIMESTAMPTZ
);

-- Active rows for a given service date — the prep list query path.
CREATE INDEX IF NOT EXISTS prep_pre_orders_business_date_active_idx
  ON prep_pre_orders (business_id, service_date)
  WHERE archived_at IS NULL;

-- Full history including archived rows for audit / list view.
CREATE INDEX IF NOT EXISTS prep_pre_orders_business_date_all_idx
  ON prep_pre_orders (business_id, service_date DESC);

-- ─────────────────────────────────────────────────────────────────────
-- RLS — same org-isolation pattern as the rest of inventory.

ALTER TABLE prep_pre_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prep_pre_orders_org_isolation ON prep_pre_orders;
CREATE POLICY prep_pre_orders_org_isolation ON prep_pre_orders
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

-- updated_at trigger (already defined by earlier migrations).
DROP TRIGGER IF EXISTS prep_pre_orders_set_updated_at ON prep_pre_orders;
CREATE TRIGGER prep_pre_orders_set_updated_at
  BEFORE UPDATE ON prep_pre_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
