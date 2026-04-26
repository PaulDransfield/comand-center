// lib/sync/eligibility.ts
//
// Decides which integrations a sync entry point should attempt this run.
// Centralised so master-sync, catchup-sync, /api/resync and /api/sync/today
// agree on the same rule — drift between them was how integrations got
// silently wedged for ~24 h after a single transient PK auth blip.
//
// THREE kinds of integration are eligible:
//
//   1. status = 'connected'                      — happy path, always sync
//   2. status = 'needs_reauth' AND last probe    — defensive probe so a
//      attempt > REAUTH_PROBE_BACKOFF_MS ago       transient 401/403 doesn't
//                                                  permanently lock the
//                                                  integration out of cron.
//                                                  If the probe succeeds,
//                                                  runSync() resets status
//                                                  to 'connected' (engine.ts
//                                                  line ~1199). If it fails,
//                                                  the engine refreshes
//                                                  reauth_notified_at, so we
//                                                  back off for another 6 h
//                                                  before trying again.
//   3. status = 'error'                          — added 2026-04-26 after
//                                                  Vero/Rosali integrations
//                                                  got wedged in 'error' from
//                                                  pre-d60d193 code paths
//                                                  with no recovery path. The
//                                                  current engine doesn't
//                                                  WRITE 'error' anymore (only
//                                                  'connected' or 'needs_reauth')
//                                                  but legacy rows + manual SQL
//                                                  + future regressions can still
//                                                  produce it. Always probe; the
//                                                  engine's per-endpoint timeout
//                                                  (12 s × max retries) bounds
//                                                  cost if upstream is genuinely
//                                                  down. Success → status flips
//                                                  to 'connected'. Failure → no
//                                                  status change, retry next tick.
//                                                  See FIXES.md §0s.
//
// reauth_notified_at doubles as both the "last email sent" timestamp (set
// on transition into needs_reauth, so we don't email more than once per
// failure event) AND the "last probe attempted" timestamp (refreshed on
// every auth failure, so we throttle probes).

export const REAUTH_PROBE_BACKOFF_MS = 6 * 60 * 60 * 1000  // 6 hours

export interface IntegrationLite {
  id: string
  status: string
  reauth_notified_at?: string | null
}

export function isEligibleForSync(integ: IntegrationLite, now: number = Date.now()): boolean {
  if (integ.status === 'connected') return true
  if (integ.status === 'needs_reauth') {
    const lastProbe = integ.reauth_notified_at ? new Date(integ.reauth_notified_at).getTime() : 0
    return now - lastProbe > REAUTH_PROBE_BACKOFF_MS
  }
  // 'error' is always probe-eligible. The engine bounds cost via per-endpoint
  // timeout + 1 retry. Cron tick (hourly catchup) caps re-probe rate at 24/day.
  // Success path resets status='connected' so probe self-heals on first success.
  if (integ.status === 'error') return true
  return false
}

// Filter helper for callers that just want the ready-to-sync subset.
export function filterEligible<T extends IntegrationLite>(integrations: T[]): T[] {
  const now = Date.now()
  return integrations.filter(i => isEligibleForSync(i, now))
}
