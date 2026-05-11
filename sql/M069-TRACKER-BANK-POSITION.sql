-- M069 — Tracker bank-position columns (Phase 5 of the prediction system + cash visibility)
--
-- Purpose: capture the per-period net movement on Swedish BAS bank accounts
-- (1910-1979 — cash on hand, bank giro, checking, savings, foreign currency)
-- so we can surface a "Cash position" tile on the dashboard without needing
-- any new Fortnox scope. The data is already in the voucher rows we fetch;
-- we just stopped throwing it away.
--
-- BAS account ranges in scope:
--   1910-1919 — Cash on hand (kassa)
--   1920-1929 — Bank giro
--   1930-1939 — Bank checking (primary operational)
--   1940-1949 — Bank savings
--   1950-1959 — Postgiro
--   1960-1969 — Building society
--   1970-1979 — Foreign currency
-- Excluded: 1980-1989 (investments / securities — not liquid cash)
--           1200-1899 (inventory, receivables, prepaid, etc. — not cash)
--
-- Convention: positive bank_net_change = bank balance grew during the period
--             (e.g. revenue deposits exceeded supplier payments + payroll).
--             Negative = bank shrank.
--
-- 2026-05-11.

ALTER TABLE tracker_data
  ADD COLUMN IF NOT EXISTS bank_net_change BIGINT,
  ADD COLUMN IF NOT EXISTS bank_accounts   JSONB;

COMMENT ON COLUMN tracker_data.bank_net_change IS
  'Net debit-minus-credit (in SEK) across BAS bank accounts 1910-1979 for this period. Positive = cash grew, negative = cash shrank. NULL = source did not produce bank data (e.g. PDF rollups). Phase 5 cash visibility.';

COMMENT ON COLUMN tracker_data.bank_accounts IS
  'Per-BAS-account breakdown of bank movements as { "1930": { "debit": N, "credit": N, "net": N }, ... }. Same source as bank_net_change. NULL when bank_net_change is NULL.';

-- Index on (business_id, period_year, period_month) where bank_net_change is not null —
-- speeds up "running cumulative" queries on the dashboard tile.
CREATE INDEX IF NOT EXISTS idx_tracker_data_bank_position
  ON tracker_data (business_id, period_year, period_month)
  WHERE bank_net_change IS NOT NULL;
