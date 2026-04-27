-- M033-INCREMENT-AI-USAGE-ATOMIC.sql
-- ============================================================================
-- Atomic AI quota gate + global-spend RPC for /api/ask hot path.
--
-- Two problems this migration fixes:
--
-- 1) TOCTOU on the per-org daily cap.
--    Pre-fix flow in lib/ai/usage.ts:
--       checkAiLimit  → SELECT current count
--       (call Claude, ~30 s)
--       incrementAiUsage → UPDATE +1
--    Fire 100 parallel /api/ask requests — every one passes the SELECT before
--    any UPDATE lands. The "20 / day" cap turns into "20 + concurrent burst".
--    Worst-case bill multiplies by burst factor.
--
--    Fix: increment_ai_usage_checked() does INSERT … ON CONFLICT … DO UPDATE
--    in one statement, atomically returning the post-increment count + an
--    `allowed` flag. Caller decrements when allowed=false so the rejected
--    attempt doesn't tick the counter (only the first request that crosses
--    the cap pays — burst attempts above it are reverted).
--
-- 2) Full table scan of ai_request_log on every AI call.
--    Pre-fix lib/ai/usage.ts lines 160-166 read every row from the last
--    24 h and summed total_cost_usd in JS. At 50 customers × 50 calls/day
--    that's 2,500 rows fetched per AI call — quadratic-ish in customer
--    count and falls over before we onboard the next batch.
--
--    Fix: ai_spend_24h_global_usd() does the SUM in Postgres against a
--    DESC index on created_at — single index scan, single number returned.
--
-- Both helpers are STABLE / VOLATILE accordingly. Granted to authenticated
-- + service_role only — no anon access.
--
-- ── Backwards compat ────────────────────────────────────────────────────────
-- The old increment_ai_usage(p_org_id, p_date) RPC referenced from
-- incrementAiUsage() was never deployed (lib/ai/usage.ts already falls
-- back to manual upsert). Both helpers stay on disk for the cron-driven
-- AI agents (anomaly explainer, weekly digest, etc.) that don't need
-- atomicity. /api/ask is the only burst-sensitive caller and it switches
-- to checkAndIncrementAiLimit() in the app layer.
-- ============================================================================

BEGIN;

-- ── Sanity: ensure the unique constraint the ON CONFLICT relies on exists ──
-- M002 created ai_usage_daily with `UNIQUE(org_id, date)` so this should be
-- a no-op in production, but adding belt-and-braces for any environment that
-- was rebuilt from a snapshot before M002.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.ai_usage_daily'::regclass
       AND contype  = 'u'
       AND conkey   = ARRAY[
         (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'public.ai_usage_daily'::regclass AND attname = 'org_id'),
         (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'public.ai_usage_daily'::regclass AND attname = 'date')
       ]::SMALLINT[]
  ) THEN
    ALTER TABLE public.ai_usage_daily
      ADD CONSTRAINT ai_usage_daily_org_date_unique UNIQUE (org_id, date);
  END IF;
END $$;

-- ── 1) Atomic check-and-increment for the per-org daily cap ────────────────
-- Returns (new_count, allowed). Increment ALWAYS happens; caller is
-- responsible for decrementing if allowed=false (so burst-rejects don't
-- starve future legitimate calls today).
CREATE OR REPLACE FUNCTION public.increment_ai_usage_checked(
  p_org_id UUID,
  p_date   DATE,
  p_limit  INT
) RETURNS TABLE(new_count INT, allowed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INT;
BEGIN
  INSERT INTO public.ai_usage_daily (org_id, date, query_count)
  VALUES (p_org_id, p_date, 1)
  ON CONFLICT (org_id, date)
  DO UPDATE SET query_count = public.ai_usage_daily.query_count + 1
  RETURNING query_count INTO v_count;

  RETURN QUERY SELECT v_count, (v_count <= p_limit);
END;
$$;

REVOKE ALL ON FUNCTION public.increment_ai_usage_checked(UUID, DATE, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_ai_usage_checked(UUID, DATE, INT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.increment_ai_usage_checked(UUID, DATE, INT) IS
  'Atomic increment of ai_usage_daily.query_count. Returns post-increment count and allowed flag (count <= p_limit). Caller decrements when allowed=false.';

-- ── 2) Rolling 24h global spend (kill-switch denominator) ──────────────────
-- Single SUM against the index below — replaces the lib/ai/usage.ts table
-- scan that loaded every row and summed in JS.
CREATE OR REPLACE FUNCTION public.ai_spend_24h_global_usd()
RETURNS NUMERIC
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(SUM(total_cost_usd), 0)::NUMERIC
    FROM public.ai_request_log
   WHERE created_at > now() - interval '24 hours';
$$;

REVOKE ALL ON FUNCTION public.ai_spend_24h_global_usd() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_spend_24h_global_usd()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ai_spend_24h_global_usd() IS
  'SUM(total_cost_usd) on ai_request_log for last 24h. Used by checkAiLimit kill-switch gate; replaces full-table scan.';

-- ── 3) Hot index for the rolling-window sums ───────────────────────────────
-- Powers ai_spend_24h_global_usd() and the per-org monthly ceiling SELECT
-- in lib/ai/usage.ts (.gte('created_at', monthStart)). DESC because the
-- rolling-window predicates always look at recent rows.
CREATE INDEX IF NOT EXISTS idx_ai_request_log_created_at
  ON public.ai_request_log (created_at DESC);

-- Org-scoped variant for the monthly ceiling: WHERE org_id=? AND created_at>=?
-- Composite (org_id, created_at DESC) lets Postgres seek straight to this
-- org's recent rows without the rolling-window scan touching other orgs.
CREATE INDEX IF NOT EXISTS idx_ai_request_log_org_created_at
  ON public.ai_request_log (org_id, created_at DESC);

-- ── Verify ──────────────────────────────────────────────────────────────────
SELECT proname, pronargs
  FROM pg_proc
 WHERE proname IN ('increment_ai_usage_checked', 'ai_spend_24h_global_usd')
 ORDER BY proname;

SELECT indexname FROM pg_indexes
 WHERE tablename = 'ai_request_log'
   AND indexname IN ('idx_ai_request_log_created_at', 'idx_ai_request_log_org_created_at')
 ORDER BY indexname;

SELECT conname FROM pg_constraint
 WHERE conrelid = 'public.ai_usage_daily'::regclass
   AND contype  = 'u';

COMMIT;
