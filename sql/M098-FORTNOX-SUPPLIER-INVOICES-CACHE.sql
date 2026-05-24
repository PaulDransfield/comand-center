-- M098 — fortnox_supplier_invoices cache (FORTNOX-LOCAL-CACHE-PLAN.md Phase 1)
--
-- Read-path scaling. Pre-M098, every dashboard render hit Fortnox's
-- /supplierinvoices live: 25 req/5sec rate limit, 500-1500ms per call.
-- Fine at 2 customers, breaks at customer #3+ when bursts (lunch-hour
-- traffic) exceed the budget.
--
-- This migration adds a local cache populated by a daily sync cron;
-- user-facing reads (recent-invoices feed, dashboard card, /invoices
-- page) hit the cache. file_id is fetched lazily on first PDF view
-- (then persisted) — never store binaries.

BEGIN;

CREATE TABLE IF NOT EXISTS fortnox_supplier_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,

  -- Fortnox identity (given_number is the canonical, string-typed for safety)
  given_number    TEXT NOT NULL,
  invoice_number  TEXT,
  supplier_name   TEXT NOT NULL,
  supplier_number TEXT,                           -- Fortnox supplier id (number-typed in API but TEXT here)
  supplier_normalised TEXT,                       -- lowercase + stripped; for fuzzy matching

  -- Dates + money
  invoice_date    DATE NOT NULL,
  bookkeeping_date DATE,
  due_date        DATE,
  total           NUMERIC(14, 2),
  currency        TEXT,                           -- usually SEK
  vat             NUMERIC(14, 2),
  balance         NUMERIC(14, 2),                 -- outstanding; 0 = fully paid
  final_pay_date  DATE,                           -- last partial payment date when fully paid

  -- Voucher linkage (for joining to vouchers / drilldown)
  voucher_series  TEXT,
  voucher_number  INTEGER,

  -- File metadata — populated lazily on first PDF view click
  file_id         TEXT,
  file_id_fetched_at TIMESTAMPTZ,
  has_pdf         BOOLEAN GENERATED ALWAYS AS (file_id IS NOT NULL) STORED,

  -- Misc
  comments        TEXT,
  cancelled       BOOLEAN NOT NULL DEFAULT FALSE,
  raw_data        JSONB,                          -- full Fortnox response — useful for debugging schema drift

  -- Sync telemetry
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fortnox_supplier_invoices_business_given_unique UNIQUE (business_id, given_number)
);

CREATE INDEX IF NOT EXISTS idx_fsi_business_date
  ON fortnox_supplier_invoices (business_id, invoice_date DESC);

CREATE INDEX IF NOT EXISTS idx_fsi_business_supplier
  ON fortnox_supplier_invoices (business_id, supplier_normalised);

CREATE INDEX IF NOT EXISTS idx_fsi_voucher_link
  ON fortnox_supplier_invoices (business_id, voucher_series, voucher_number)
  WHERE voucher_series IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fsi_has_pdf
  ON fortnox_supplier_invoices (business_id, has_pdf)
  WHERE has_pdf;

-- ───────────────────────────────────────────────────────────────────
-- fortnox_sync_state — last successful sync per (business, resource).
-- Lets the sync cron resume from the cursor instead of always pulling
-- the whole last-12-months.

CREATE TABLE IF NOT EXISTS fortnox_sync_state (
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  resource         TEXT NOT NULL,                 -- 'supplier_invoices' | 'vouchers' | 'accounts'
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_cursor_date DATE,                          -- the to-date of the last sync window
  rows_synced      INTEGER,                       -- how many rows the last sync touched (telemetry)
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, resource)
);

CREATE INDEX IF NOT EXISTS idx_fortnox_sync_state_resource
  ON fortnox_sync_state (resource, last_synced_at);

-- ───────────────────────────────────────────────────────────────────
-- RLS

ALTER TABLE fortnox_supplier_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE fortnox_sync_state        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fsi_org_isolation ON fortnox_supplier_invoices;
CREATE POLICY fsi_org_isolation ON fortnox_supplier_invoices
  FOR ALL TO authenticated
  USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS fortnox_sync_state_select ON fortnox_sync_state;
CREATE POLICY fortnox_sync_state_select ON fortnox_sync_state
  FOR SELECT TO authenticated
  USING (business_id IN (
    SELECT b.id FROM businesses b WHERE b.org_id = ANY(current_user_org_ids())
  ));

-- fortnox_sync_state has updated_at; fortnox_supplier_invoices uses
-- last_synced_at exclusively (it's never edited by hand).
CREATE TRIGGER fortnox_sync_state_set_updated_at
  BEFORE UPDATE ON fortnox_sync_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
