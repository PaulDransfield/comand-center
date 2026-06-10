-- M143 — forecast metric views: enforce SECURITY INVOKER
--
-- Supabase's security advisor flags the M070 forecast measurement views
-- (v_forecast_confidence_calibration et al.) as SECURITY DEFINER. A
-- Postgres view runs with the VIEW OWNER's permissions + RLS by default;
-- the advisor wants `security_invoker = on` so the view instead enforces
-- the QUERYING user's permissions and RLS policies.
--
-- Safe here: the only reader is the admin forecasting route via the
-- service_role key (app/api/admin/v2/forecasting/route.ts), which bypasses
-- RLS regardless. Flipping to invoker satisfies the advisor without
-- changing behaviour for that caller, and closes the hole where a
-- lower-privileged role could otherwise read the underlying ledger
-- through the view.
--
-- Idempotent — ALTER VIEW ... SET is a no-op if already set.

ALTER VIEW public.v_forecast_mape_by_horizon_bucket        SET (security_invoker = on);
ALTER VIEW public.v_forecast_confidence_calibration        SET (security_invoker = on);
ALTER VIEW public.v_forecast_mape_rolling_28d              SET (security_invoker = on);
ALTER VIEW public.v_forecast_horizon_confidence_breakdown  SET (security_invoker = on);

-- ── Verification ─────────────────────────────────────────────────────
-- Confirm the option is now set on each view (reloptions should contain
-- 'security_invoker=on'). Expect 4 rows.
SELECT
  c.relname           AS view_name,
  c.reloptions        AS options
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN (
    'v_forecast_mape_by_horizon_bucket',
    'v_forecast_confidence_calibration',
    'v_forecast_mape_rolling_28d',
    'v_forecast_horizon_confidence_breakdown'
  )
ORDER BY c.relname;
