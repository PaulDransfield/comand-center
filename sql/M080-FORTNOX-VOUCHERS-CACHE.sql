-- M080 — Local cache for Fortnox vouchers
--
-- Fortnox /3/vouchers detail fetches are rate-limited (25 req / 5 sec)
-- and serial. Chicce's February with ~250 vouchers takes 90-120 seconds
-- to fully fetch — too slow for the verifikationslista UI to feel
-- responsive. This cache stores fetched voucher rows by
-- (business_id, period_year, voucher_series, voucher_number) so:
--
--   - R2 SIE export and R3 verifikationslista both read from here
--   - First fetch of a month is slow (still ~2 min from Fortnox)
--   - Every subsequent read is < 50 ms (Postgres index lookup)
--   - Closed periods stay cached indefinitely — they never change
--   - Current + previous month get refreshed by a daily cron (separate
--     commit; not in this migration)
--
-- One row per Fortnox voucher. VoucherRows array stored as JSONB so we
-- preserve every field Fortnox returns (Account, Debit, Credit,
-- TransactionInformation, Description, etc.) without forcing a schema
-- migration every time Fortnox adds a row-level field.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.fortnox_vouchers_cache (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id      UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,

  -- Composite voucher identity
  voucher_series   TEXT NOT NULL,
  voucher_number   INTEGER NOT NULL,
  transaction_date DATE NOT NULL,

  -- Voucher header fields
  description      TEXT,
  reference_number TEXT,
  reference_type   TEXT,
  comments         TEXT,
  fortnox_year     INTEGER,                  -- Fortnox's fiscal year id (not always = calendar year)

  -- Full row payload (FortnoxVoucherRow[]) — keeps every field Fortnox
  -- exposes per row. JSONB to allow GIN indexing for "find vouchers
  -- touching account X" queries.
  rows             JSONB NOT NULL,

  -- Aggregates so the verifikationslista's grand-totals query doesn't
  -- have to scan the JSONB
  rows_count       INTEGER NOT NULL DEFAULT 0,
  debit_total      NUMERIC NOT NULL DEFAULT 0,
  credit_total     NUMERIC NOT NULL DEFAULT 0,

  -- Cache management
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Period derivation — store explicitly rather than computed columns
  -- so we can index them (PostgreSQL generated columns can be
  -- indexed but the syntax varies; explicit is simpler + portable).
  period_year      INTEGER NOT NULL,
  period_month     INTEGER NOT NULL,

  CONSTRAINT fortnox_vouchers_cache_uniq
    UNIQUE (business_id, period_year, voucher_series, voucher_number)
);

-- Primary read path: "give me all vouchers for (business, year, month)"
CREATE INDEX IF NOT EXISTS fortnox_vouchers_cache_period_idx
  ON public.fortnox_vouchers_cache (business_id, period_year, period_month, transaction_date);

-- For "find vouchers touching account N" queries (R4/R5 will use this)
CREATE INDEX IF NOT EXISTS fortnox_vouchers_cache_rows_gin_idx
  ON public.fortnox_vouchers_cache USING GIN (rows);

-- For freshness checks: "when did we last fetch this month?"
CREATE INDEX IF NOT EXISTS fortnox_vouchers_cache_fetched_idx
  ON public.fortnox_vouchers_cache (business_id, period_year, period_month, fetched_at DESC);

-- RLS — same multi-tenant pattern as everything else
ALTER TABLE public.fortnox_vouchers_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fortnox_vouchers_cache_select ON public.fortnox_vouchers_cache;
CREATE POLICY fortnox_vouchers_cache_select ON public.fortnox_vouchers_cache
  FOR SELECT USING (org_id = ANY(current_user_org_ids()));

DROP POLICY IF EXISTS fortnox_vouchers_cache_modify ON public.fortnox_vouchers_cache;
CREATE POLICY fortnox_vouchers_cache_modify ON public.fortnox_vouchers_cache
  FOR ALL USING (org_id = ANY(current_user_org_ids()))
  WITH CHECK (org_id = ANY(current_user_org_ids()));

COMMENT ON TABLE public.fortnox_vouchers_cache IS
  'Local cache of Fortnox voucher data. Populated on first request for '
  'a (business, year, month) tuple via lib/fortnox/voucher-cache.ts. '
  'Closed periods cached indefinitely; current + previous month '
  'refreshed daily by /api/cron/voucher-cache-refresh.';
