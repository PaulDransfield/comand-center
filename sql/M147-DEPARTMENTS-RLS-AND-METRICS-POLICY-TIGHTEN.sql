-- M147 — (1) ERROR fix: enable RLS on public.departments (lint 0013).
--        (2) Drop the always-true ALL policies on metrics/cache tables
--            (lint 0024 rls_policy_always_true).
--
-- All five tables are accessed ONLY server-side via the service_role key
-- (verified: every reader uses createAdminClient(); no browser/authenticated
-- .from() on them). service_role bypasses RLS, so the app is unaffected.
-- Enabling RLS with no permissive policy, and dropping the
-- USING(true)/WITH CHECK(true) ALL policies, denies direct anon/authenticated
-- access — closing a cross-tenant read/write hole on the metrics tables.
--
-- Applied 2026-06-10.

-- (1) ERROR — rls_disabled_in_public
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- (2) WARN — rls_policy_always_true
DROP POLICY IF EXISTS daily_metrics_service_all            ON public.daily_metrics;
DROP POLICY IF EXISTS dept_metrics_service_all             ON public.dept_metrics;
DROP POLICY IF EXISTS monthly_metrics_service_all          ON public.monthly_metrics;
DROP POLICY IF EXISTS overhead_drilldown_cache_service_all ON public.overhead_drilldown_cache;
