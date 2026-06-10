-- M146 — revoke EXECUTE from anon/authenticated/PUBLIC on SECURITY DEFINER
-- functions that are only ever called server-side (service_role) or by
-- pg_cron. Closes advisor lints 0028/0029 (anon/authenticated executable
-- SECURITY DEFINER RPCs).
--
-- IMPORTANT: revoking only anon+authenticated is NOT enough — Postgres
-- grants EXECUTE to PUBLIC by default, and anon/authenticated inherit
-- PUBLIC. Must REVOKE ... FROM PUBLIC. service_role + postgres keep their
-- explicit grants, so the app + cron are unaffected. Verified live: each
-- of these now lists executors = {postgres, service_role} only.
--
-- DELIBERATELY NOT LOCKED DOWN — the RLS-helper functions
-- current_org_id(), current_user_org_ids(), get_my_org_id(), is_org_admin():
-- RLS policies invoke them, so the querying role MUST retain EXECUTE or
-- row-level security breaks. They only return the caller's own org, so the
-- residual advisor warning on them is benign and accepted.
--
-- Applied 2026-06-10.

DO $$
DECLARE fn text;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'public.admin_run_sql(text,integer)',
    'public.admin_health_rls()',
    'public.acquire_fortnox_refresh_lock(uuid,text)',
    'public.release_fortnox_refresh_lock(uuid)',
    'public.claim_next_extraction_job()',
    'public.fire_extraction_worker()',
    'public.list_ready_extraction_jobs(integer)',
    'public.reset_stale_extraction_jobs()',
    'public.claim_stripe_event(text,text,integer)',
    'public.mark_stripe_event_processed(text)',
    'public.increment_ai_usage_checked(uuid,date,integer)',
    'public.prune_ai_forecast_outcomes()',
    'public.prune_daily_forecast_outcomes()',
    'public.upsert_ai_log_archive(date,uuid,text,text,integer,bigint,bigint,numeric,numeric,bigint)'
  ])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn);
  END LOOP;
END $$;
