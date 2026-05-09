-- M062 — tag tracker_data rows as provisional (current month + prior month
-- before mid-month closure)
--
-- Why: Fortnox API returns whatever's been booked into the customer's
-- accounting at fetch time, but Swedish restaurants typically close monthly
-- books between the 5th and 15th of the following month. So:
--   - Current month: revenue partial (no Z-reports yet), supplier costs
--     accumulating, staff cost = 0 (salary booked 25th)
--   - Prior month, before 15th: revenue partial, staff cost still pending,
--     month not "closed" in any meaningful sense
--   - Prior month, 15th+: typically closed, full numbers
--
-- Without a flag, partial Apr 2026 / May 2026 rows muddy:
--   - 12-month rolling averages (revenue spikes/dips)
--   - YoY comparisons (April 2026 = 85k vs April 2025 = 625k looks like
--     a 86% revenue collapse, when reality is just "month not closed")
--   - AI prompts (budget AI sees April as a catastrophic month)
--   - Trend charts (last data point looks alarming)
--
-- Solution: tag every tracker_data row with is_provisional. Readers that
-- want clean P&L data filter `is_provisional = false`. Live operational
-- views (today's invoices, this-month-so-far tile) opt-in to provisional
-- data via `is_provisional = true OR is_provisional IS NULL` (the IS NULL
-- branch covers historical rows pre-this-migration).
--
-- The flag is set by the writer (Fortnox backfill worker, future PDF apply).
-- It's NOT recomputed at read time — that would be expensive and ambiguous
-- across timezones. Each writer applies its own provisional-time heuristic
-- at write moment.
--
-- Idempotent.

ALTER TABLE public.tracker_data
  ADD COLUMN IF NOT EXISTS is_provisional BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: any existing row dated current or prior calendar month gets
-- flagged provisional. Older rows are by definition closed (the books
-- were closed weeks/months ago).
UPDATE public.tracker_data
   SET is_provisional = TRUE
 WHERE (period_year, period_month) IN (
   -- current month
   (EXTRACT(YEAR  FROM CURRENT_DATE)::int, EXTRACT(MONTH FROM CURRENT_DATE)::int),
   -- prior month, only if today is before the 15th
   (CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE)::int = 1
              THEN EXTRACT(YEAR FROM CURRENT_DATE)::int - 1
              ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int END,
    CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE)::int = 1
              THEN 12
              ELSE EXTRACT(MONTH FROM CURRENT_DATE)::int - 1 END)
 )
   AND EXTRACT(DAY FROM CURRENT_DATE)::int < 15
   AND is_provisional IS NOT TRUE;

-- Index helps readers that filter `WHERE is_provisional = false`. Partial
-- index keeps it small (typically <1% of rows are provisional at any time).
CREATE INDEX IF NOT EXISTS idx_tracker_data_provisional
  ON public.tracker_data (business_id, period_year, period_month)
  WHERE is_provisional = TRUE;

-- Verification
SELECT is_provisional, COUNT(*) AS rows
FROM public.tracker_data
GROUP BY is_provisional
ORDER BY is_provisional NULLS LAST;
