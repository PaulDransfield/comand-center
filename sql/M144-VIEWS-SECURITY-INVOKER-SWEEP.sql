-- M144 — remaining public views: enforce SECURITY INVOKER (advisor sweep)
--
-- Follow-up to M143. The Supabase security advisor flagged
-- public.invoices_with_status as SECURITY DEFINER. Rather than fix one at
-- a time, this migration sweeps EVERY public view still missing
-- `security_invoker = on` so the advisor's "SECURITY DEFINER view" class
-- is cleared in full.
--
-- Views fixed here (M070's four were already done in M143):
--   · invoices_with_status      — computed status/overdue over public.invoices.
--                                 (The CREATE VIEW lives only in the DB — never
--                                  in a tracked SQL file — so this ALTER is its
--                                  source of truth for the option.)
--   · v_forecast_mape_by_surface — M065 base MAPE view (admin/service_role read).
--
-- Safe: every reader of these views uses the service_role key, which
-- bypasses RLS regardless. Flipping to invoker satisfies the advisor and
-- closes the path where a lower-privileged role could read the underlying
-- tables through the view.
--
-- Idempotent — ALTER VIEW ... SET is a no-op if already set.

ALTER VIEW public.invoices_with_status        SET (security_invoker = on);
ALTER VIEW public.v_forecast_mape_by_surface  SET (security_invoker = on);

-- ── Verification ─────────────────────────────────────────────────────
-- Expect 0: no public view should be left without security_invoker=on.
SELECT COUNT(*) AS views_missing_invoker
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND (c.reloptions IS NULL OR NOT ('security_invoker=on' = ANY(c.reloptions)));
