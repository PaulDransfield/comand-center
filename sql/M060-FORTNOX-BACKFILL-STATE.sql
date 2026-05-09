-- M060 — Fortnox backfill resumability state table
--
-- Why: 12-month+ backfills exceed Vercel's 600s function timeout (Vero
-- alone has ~3,800 vouchers in 12 months, ~17.5 min at the 18 req/5sec
-- throttle). Without resumability, every backfill that crosses the
-- timeout dies with the integration row stuck at 'running'. Operators
-- have to manually reset and re-run smaller windows.
--
-- This table persists the work-in-progress so a worker can checkpoint
-- before timing out, and the next invocation (chain-fired via waitUntil
-- or the daily cron backstop) picks up where the previous one left off.
--
-- State lifecycle:
--   1. Worker claims a 'pending' integration row.
--   2. Phase 1: fetch voucher summaries from Fortnox /vouchers (paginated
--      list calls, ~20-30s for 4000 vouchers). Persist the full summary
--      list to voucher_queue. Set cursor=0.
--   3. Phase 2 loop: for each summary, fetch detail, accumulate by period.
--      When a period is fully fetched, translate + project + validate +
--      write tracker_data + add to written_periods. Bump cursor.
--   4. On time-budget hit (~80% of maxDuration): persist state, set
--      integrations.backfill_status='paused', waitUntil(triggerNext) to
--      chain another worker invocation. Return without timing out.
--   5. Next worker invocation: claim 'paused' row, load state row,
--      resume from cursor. (Skip Phase 1 — voucher_queue is already populated.)
--   6. Phase 3: when cursor === voucher_queue.length, mark
--      backfill_status='completed', delete the state row.
--
-- Idempotency: voucher_queue and written_periods are append-only within
-- one backfill run. Each tracker_data write is idempotent via
-- (business_id, period_year, period_month). If the worker crashes between
-- "write tracker_data" and "update state row", the next resume re-writes
-- the same period (same UPSERT), no duplicate rows.
--
-- Cleanup: state rows persist only while a backfill is in flight. On
-- 'completed' or 'failed', the worker deletes the row. ON DELETE CASCADE
-- via integrations(id) handles the case where an integration is removed
-- mid-flight.

CREATE TABLE IF NOT EXISTS public.fortnox_backfill_state (
  integration_id    UUID        PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
  org_id            UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id       UUID        REFERENCES businesses(id) ON DELETE CASCADE,

  -- Phase 1 output: full list of voucher summaries to process. Each entry
  -- carries the fiscal-year context (__fyId / __fyDate) so the resume
  -- detail-fetch can set the correct Fortnox-Financial-Year header.
  -- Shape per element:
  --   { Url, VoucherSeries, VoucherNumber, Year, TransactionDate,
  --     __fyId: number, __fyDate: 'YYYY-MM-DD' }
  voucher_queue     JSONB       NOT NULL,
  total_vouchers    INTEGER     NOT NULL DEFAULT 0,

  -- Cursor: index into voucher_queue of the next summary to fetch.
  -- 0 = start. cursor === total_vouchers = done.
  cursor            INTEGER     NOT NULL DEFAULT 0,

  -- Periods written so far. Set of 'YYYY-MM' strings (JSONB array).
  -- Used to skip already-written periods on resume so we don't re-fetch
  -- + re-translate vouchers for periods already in tracker_data.
  written_periods   JSONB       NOT NULL DEFAULT '[]'::JSONB,

  -- Range bounds (set during Phase 1, used for diagnostics).
  from_date         DATE,
  to_date           DATE,

  -- Telemetry
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_progress_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resume_count      INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT cursor_in_bounds CHECK (cursor >= 0 AND cursor <= total_vouchers)
);

CREATE INDEX IF NOT EXISTS idx_fortnox_backfill_state_business
  ON public.fortnox_backfill_state (business_id);

ALTER TABLE public.fortnox_backfill_state ENABLE ROW LEVEL SECURITY;

-- Service-role only — no operator UI needs to read this directly.
-- (Status surfaces via integrations.backfill_progress JSONB, which has
--  a RLS policy member-read.) No write or read policies for non-service.

-- Verification
SELECT COUNT(*) AS fortnox_backfill_state_rows FROM public.fortnox_backfill_state;
