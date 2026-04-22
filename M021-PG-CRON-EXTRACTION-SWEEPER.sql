-- M021 — Replace fire-and-forget dispatcher with Postgres-native scheduling
-- Run once in Supabase SQL Editor. Idempotent.
--
-- Rationale (from Claude's architecture review, item 4):
--   The dispatcher's waitUntil(fetch()) to /api/fortnox/extract-worker
--   fails silently ~0.5% of the time (cold-start timing, cloudflare blip,
--   whatever). Jobs sit in 'pending' until the Vercel cron sweeps at
--   */2 * * * *. On Hobby that was daily; on Pro we sweep every 2 min
--   which is good but still not ideal.
--
--   pg_cron inside Supabase gives us 20-second scheduling that runs at
--   the DB layer, so we lose the HTTP hop entirely. The cron just POSTs
--   to the worker with CRON_SECRET auth; if the HTTP call itself fails,
--   the job stays pending and the NEXT tick retries within 20s.
--
-- Setup instructions — run these in this order.

-- ── 1. Enable pg_cron + pg_net extensions ─────────────────────────────
-- Supabase ships pg_cron pre-installed on Pro plan. pg_net lets the
-- cron function make HTTPS calls out to the Vercel worker endpoint.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- ── 2. Store the worker URL + CRON_SECRET as vault secrets ─────────────
-- Supabase Vault is the secure place for this. After applying this
-- migration, go to Supabase Dashboard → Project Settings → Vault and
-- add two secrets manually:
--
--   name: cc_worker_url
--   value: https://www.comandcenter.se/api/fortnox/extract-worker
--
--   name: cc_cron_secret
--   value: <the CRON_SECRET from Vercel env vars>
--
-- The cron function below reads them by name via vault.decrypted_secrets.

-- ── 3. Function that fires the worker ─────────────────────────────────
-- Called by pg_cron every 20 seconds. Uses pg_net to POST to the
-- Vercel worker endpoint with the CRON_SECRET bearer token. The worker
-- drains up to 5 jobs per invocation (configured server-side).
create or replace function fire_extraction_worker()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  worker_url  text;
  cron_secret text;
  request_id  bigint;
begin
  -- Read secrets from vault. Fail silently if unset so applying this
  -- migration doesn't crash when the secrets haven't been configured yet.
  select decrypted_secret into worker_url
    from vault.decrypted_secrets where name = 'cc_worker_url' limit 1;
  select decrypted_secret into cron_secret
    from vault.decrypted_secrets where name = 'cc_cron_secret' limit 1;

  if worker_url is null or cron_secret is null then
    raise notice '[fire_extraction_worker] vault secrets missing (cc_worker_url or cc_cron_secret) — skipping';
    return;
  end if;

  -- Only fire if there's actually work — avoids hammering the endpoint
  -- when the queue is idle.
  if not exists (
    select 1 from extraction_jobs
    where status = 'pending' and scheduled_for <= now()
    limit 1
  ) then
    return;
  end if;

  -- Fire-and-forget POST. pg_net handles this async; we don't wait for
  -- the response here. Worker authenticates via Bearer header.
  select net.http_post(
    url := worker_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || cron_secret
    ),
    body := jsonb_build_object('trigger', 'pg_cron')
  ) into request_id;
end;
$$;

grant execute on function fire_extraction_worker() to service_role;

-- ── 4. Schedule the cron ──────────────────────────────────────────────
-- Every 20 seconds. Idempotent: unschedule any existing job with this
-- name first, then re-schedule cleanly.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'cc-fire-extraction-worker') then
    perform cron.unschedule('cc-fire-extraction-worker');
  end if;
end $$;

select cron.schedule(
  'cc-fire-extraction-worker',
  '20 seconds',
  $$ select fire_extraction_worker(); $$
);

-- ── 5. Stale-processing auto-release (5-minute claim_timeout) ─────────
-- Belt-and-braces: if a worker claims a job and then crashes mid-Anthropic
-- call (Vercel timeout, OOM, whatever), the job stays 'processing' until
-- reset_stale_extraction_jobs() runs. That RPC already exists (M017); pg_cron
-- now invokes it every minute instead of waiting for the Vercel sweeper.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'cc-reset-stale-extraction-jobs') then
    perform cron.unschedule('cc-reset-stale-extraction-jobs');
  end if;
end $$;

select cron.schedule(
  'cc-reset-stale-extraction-jobs',
  '1 minute',
  $$ select reset_stale_extraction_jobs(); $$
);

-- ── 6. Verification (run manually after the migration + vault setup) ──
-- Expected: two rows, both 'scheduled' status, next_run within 20s / 60s.
-- select jobname, schedule, active, last_run_started_at, last_run_finished_at
-- from cron.job
-- where jobname in ('cc-fire-extraction-worker', 'cc-reset-stale-extraction-jobs');
