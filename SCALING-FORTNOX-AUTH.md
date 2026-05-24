# Scaling Fortnox auth to 20+ customers

> Status: planned. Some pieces implemented (in-process refresh dedupe);
> the cross-process race is real but not yet plugged. Revisit when we
> see the second invalid_grant incident OR cross 5 active Fortnox
> integrations — whichever first.

## The bug class (incident 2026-05-24)

Both Vero + Chicce ended up `status='error'` simultaneously at 11:00 UTC
with `invalid_grant — Invalid refresh token`. Root cause: two crons
(master-sync + catchup-sync, OR catchup-sync + a UI-driven sync)
hit the same integration row at the same wall-clock second. Both read
the same `refresh_token_v1` from `credentials_enc`. Both posted it to
Fortnox's token endpoint. Fortnox refresh tokens are **single-use** —
one request succeeded and returned `refresh_token_v2`, the other got
`invalid_grant`. The losing one's error propagated up + the sync
wrapper marked the row `status='error'`. Owner had to re-OAuth.

At 1-2 customers this happens roughly never. At 20 customers with
hourly catchup-sync + nightly master-sync + UI-driven token refreshes,
expected races/month = O(5-10). Each one kills an integration until
the owner notices + re-OAuths. Operationally that's a major drag.

## What we've already shipped (Session 20)

- **One refresh helper**: consolidated `lib/sync/engine.ts`'s
  `ensureFreshFortnoxToken` and `lib/fortnox/api/vouchers.ts`'s
  `ensureFreshToken` into `lib/fortnox/api/auth.ts`'s
  `getFreshFortnoxCreds` / `getFreshFortnoxAccessToken`. One file owns
  the refresh logic.
- **In-process dedupe**: `inflightRefreshes: Map<integration_id, Promise>`
  in auth.ts. When two concurrent callers in the SAME Vercel function
  invocation both want a refresh, only one hits Fortnox; the other
  awaits the same promise. Covers the "syncFortnox + sub-sync called
  by the same crow run" case.
- **invalid_grant → needs_reauth**: when Fortnox rejects the refresh,
  we flip `status='needs_reauth'` and throw a tagged error so callers
  can short-circuit instead of looping on a dead token.

## What's still racy

The in-process dedupe doesn't cover **cross-invocation** races: two
separate Vercel function executions both reading the same row. Common
scenarios:

1. Cron A and Cron B fire at the same minute (master-sync + a UI
   visit triggering an on-demand sync).
2. Cron A spans two minutes; cron B fires while A still running.
3. The Stripe checkout webhook handler running while the daily cron
   runs.

Each Vercel invocation has its own process, so its own
`inflightRefreshes` map.

## The fix that scales (not yet implemented)

### Option 1: DB advisory lock (recommended)

Postgres advisory locks scoped per integration row:

```sql
SELECT pg_try_advisory_xact_lock(hashtext('fortnox-refresh:' || integration_id::text));
```

In auth.ts's refresh path:
1. Open a short transaction
2. `SELECT pg_try_advisory_xact_lock(hash)` — if false (someone else has it), commit + sleep 1s + re-read `credentials_enc` (the other process likely just wrote it), validate it's fresh, return
3. If true: do the refresh, persist, commit (lock auto-releases on COMMIT)

Pros: bulletproof; no race possible.
Cons: adds ~10ms to every refresh; needs a Postgres connection that
survives the operation (Supabase RPC, NOT supabase-js).

### Option 2: Optimistic re-read

Cheaper but not bulletproof:

1. Read creds → if expiring, refresh
2. Before POST to Fortnox, re-read creds. If `expires_at` has moved
   into the future by more than 1 minute since our first read,
   another process just refreshed → use the new token, don't refresh.
3. POST to Fortnox.
4. On invalid_grant: re-read creds. If `expires_at` is fresh,
   another process raced and won. Use the new token.

Pros: no infrastructure changes, just code.
Cons: still possible to race in the millisecond between re-read and POST.
Reduces incident rate maybe 90%, not 100%.

### Recommendation

Ship Option 2 first (1-day implementation), measure incidents over a
month, then add Option 1 if races still happen. Most customers will
never hit a true millisecond race.

## Operational mitigations to ship NOW

These reduce the impact of any future race without preventing it:

1. **Self-healing watchdog**: a tiny cron (every 30 min) that checks
   for `integrations` rows in `status='needs_reauth'` and emails the
   owner with a one-click reconnect link. Right now nobody alerts —
   the owner only finds out when they click a feature that needs the
   API.

2. **Prominent banner**: when ANY integration in the current org is
   `status='needs_reauth'`, show a sticky red banner at the top of
   every page: "Fortnox connection broken for {business}. [Reconnect]"
   Currently you only see the broken state if you happen to navigate
   to /integrations.

3. **PostHog / Sentry alert**: instrument `FORTNOX_NEEDS_REAUTH`
   throws so on-call gets paged when an integration breaks. At 20
   customers operators can't manually monitor.

4. **Stagger cron schedules**: master-sync at `0 4`, catchup-sync at
   `15 4-23` (offset by 15 min) instead of overlapping windows.
   Doesn't eliminate races but reduces overlap probability.

## Effort

- Option 2 (optimistic re-read): ~3-4 hours
- Operational mitigations (1-4 above): ~half day total
- Option 1 (advisory lock): ~6-8 hours

Suggested order:
1. Operational mitigations 1-4 immediately when we hit 5 customers
2. Option 2 around customer 10
3. Option 1 around customer 25 OR after a second incident, whichever first

## Side effects of consolidation (Session 20)

Already shipped:
- `lib/sync/engine.ts` lost ~70 lines of duplicate refresh logic
- `lib/fortnox/api/vouchers.ts` lost `loadIntegration` + `ensureFreshToken`
  (~75 lines)
- All Fortnox refresh paths now go through `lib/fortnox/api/auth.ts`
- Future changes (advisory lock, optimistic re-read, retry-on-401) only
  need to land in ONE file

This is the precondition for any of the scaling fixes above. Without
consolidation, every fix would need to be applied in 2-3 places.
