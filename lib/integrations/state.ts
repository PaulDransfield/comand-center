// lib/integrations/state.ts
//
// Single writer for `integrations.status` + `last_error` + related fields.
// Every code path that needs to mutate integration state goes through
// `setIntegrationState(...)`. The function:
//
//   1. Encodes the only valid (status, last_error, last_sync_at,
//      reauth_notified_at) shape per transition. No caller has to
//      remember which fields go together for which transition — the
//      module enforces the contract.
//   2. Resolves an empty/non-Error throw to a usable error message
//      (was the source of "last_error IS NULL while status='error'"
//      black holes that took an hour to diagnose every time).
//   3. Writes one row to integration_state_log per call so we have a
//      forensic trail of every transition.
//
// Direct UPDATEs to integrations are now actively discouraged. The
// canonical CHECK constraint on integrations.status (M040) catches the
// unhappy path if someone bypasses this module.
//
// Vocabulary:
//   created               — integration row first inserted (called from connect flows)
//   sync_started          — runSync entered. No DB change today; logged so the
//                           audit trail captures a "we tried" event even if the
//                           sync explodes mid-flight.
//   sync_succeeded        — clears last_error, flips to 'connected', updates
//                           last_sync_at, clears reauth_notified_at.
//   sync_failed_retryable — generic non-auth error. status='error', last_error
//                           captured. Eligible for re-probing next tick.
//   sync_failed_auth      — 401/403 from upstream. status='needs_reauth',
//                           last_error captured, reauth_notified_at refreshed
//                           so the 6 h backoff probe (lib/sync/eligibility.ts)
//                           can throttle re-probes.
//   retired               — provider permanently disabled (Inzii). Eligibility
//                           skips these — they never sync again until manually
//                           un-retired.
//   manual_reset          — admin escape hatch. Flips to 'connected' and
//                           clears last_error so the next probe gets a clean
//                           start. Used by admin-v2 "Reset state" buttons.

type Db = any
type ISO = string

export type Transition =
  | 'created'
  | 'sync_started'
  | 'sync_succeeded'
  | 'sync_failed_retryable'
  | 'sync_failed_auth'
  | 'retired'
  | 'manual_reset'

export interface SetStateContext {
  errorMessage?:  string | null
  errorCode?:     string | null
  recordsSynced?: number
  durationMs?:    number
  actor?:         string                                 // admin user id / 'system' / 'cron'
  extra?:         Record<string, any>                    // free-form, lands in context JSONB
}

export interface SetStateResult {
  ok:           boolean
  prev_status:  string | null
  new_status:   string
}

const TERMINAL_STATUS_PER_TRANSITION: Record<Transition, string | null> = {
  // null = no status change (just an audit-log entry)
  created:               'connected',
  sync_started:          null,
  sync_succeeded:        'connected',
  sync_failed_retryable: 'error',
  sync_failed_auth:      'needs_reauth',
  retired:               'retired',
  manual_reset:          'connected',
}

/**
 * Resolve a thrown value into a non-empty error string. Failures that
 * landed as `Error('')` or `throw null` previously produced last_error=NULL
 * which made every sync incident a "we have no idea what broke" exercise.
 */
export function resolveErrorMessage(e: unknown): string {
  if (!e) return 'unknown error (empty exception)'
  if (typeof e === 'string') return e.trim() || 'unknown error (empty string thrown)'
  const anyE = e as any
  const msg  = (anyE?.message && String(anyE.message).trim()) || ''
  if (msg) return msg
  if (anyE?.name) return `${anyE.name}${anyE?.code ? ` (${anyE.code})` : ''}`
  if (anyE?.code) return `code:${anyE.code}`
  // Last resort — stringify so we capture SOMETHING.
  try {
    const stringified = JSON.stringify(anyE)
    if (stringified && stringified !== '{}') return `unknown: ${stringified.slice(0, 200)}`
  } catch {}
  return 'unknown error (no message, no name, no code)'
}

/**
 * The single function that writes integration state. Every direct
 * `db.from('integrations').update({ status: ... })` should go through here.
 */
export async function setIntegrationState(
  db:             Db,
  integrationId:  string,
  transition:     Transition,
  context:        SetStateContext = {},
): Promise<SetStateResult> {
  // Read the current row so we can capture prev_* in the audit log + know
  // whether we need to actually write. Cheap — the integrations table is
  // tiny and the row is keyed by PK.
  const { data: prev } = await db
    .from('integrations')
    .select('id, org_id, business_id, status, last_error')
    .eq('id', integrationId)
    .maybeSingle()

  const prevStatus    = prev?.status    ?? null
  const prevLastError = prev?.last_error ?? null
  const targetStatus  = TERMINAL_STATUS_PER_TRANSITION[transition]   // may be null

  // Resolve a usable error message. If caller passed one, use it; otherwise
  // fall back to the resolver so we never write null on a failure transition.
  let errMsg: string | null = null
  if (transition === 'sync_failed_retryable' || transition === 'sync_failed_auth') {
    errMsg = (context.errorMessage && context.errorMessage.trim()) || resolveErrorMessage(null)
  }

  // Build the UPDATE patch per transition. Each transition encodes ALL
  // related fields so they can never drift from each other.
  const now: ISO = new Date().toISOString()
  const updatePatch: Record<string, any> = {}

  switch (transition) {
    case 'created':
      // Caller (the connect flow) has already inserted the row. Nothing to
      // update here — this is purely an audit-log marker.
      break

    case 'sync_started':
      // No mutation. Just log so we can see in the audit trail that the
      // sync was attempted. Useful for diagnosing "the row never got
      // touched" vs "the sync ran but failed silently".
      break

    case 'sync_succeeded':
      updatePatch.status             = 'connected'
      updatePatch.last_error         = null
      updatePatch.last_sync_at       = now
      updatePatch.reauth_notified_at = null
      break

    case 'sync_failed_retryable':
      updatePatch.status     = 'error'
      updatePatch.last_error = errMsg
      // Don't touch last_sync_at — it represents the LAST SUCCESSFUL sync,
      // and an erroring sync isn't successful.
      break

    case 'sync_failed_auth':
      updatePatch.status             = 'needs_reauth'
      updatePatch.last_error         = errMsg
      updatePatch.reauth_notified_at = now
      break

    case 'retired':
      updatePatch.status     = 'retired'
      updatePatch.last_error = null
      break

    case 'manual_reset':
      updatePatch.status     = 'connected'
      updatePatch.last_error = null
      // last_sync_at unchanged — admin reset doesn't pretend the sync ran.
      break
  }

  let newStatus = prevStatus
  if (Object.keys(updatePatch).length > 0) {
    const { error: upErr } = await db
      .from('integrations')
      .update(updatePatch)
      .eq('id', integrationId)
    if (upErr) {
      console.error('[integrations/state] update failed:', upErr.message, { integrationId, transition })
      return { ok: false, prev_status: prevStatus, new_status: prevStatus ?? 'unknown' }
    }
    newStatus = updatePatch.status ?? prevStatus
  }

  // Audit log — best-effort. If the table doesn't exist yet (migration
  // unapplied) we still want the actual update to land.
  try {
    await db.from('integration_state_log').insert({
      integration_id:  integrationId,
      org_id:          prev?.org_id ?? null,
      business_id:     prev?.business_id ?? null,
      transition,
      prev_status:     prevStatus,
      new_status:      newStatus ?? prevStatus,
      prev_last_error: prevLastError,
      new_last_error:  Object.prototype.hasOwnProperty.call(updatePatch, 'last_error')
                         ? updatePatch.last_error
                         : prevLastError,
      context: {
        ...(context.errorCode  ? { error_code:     context.errorCode }     : {}),
        ...(context.errorMessage ? { error_message: errMsg ?? context.errorMessage } : {}),
        ...(typeof context.recordsSynced === 'number' ? { records_synced: context.recordsSynced } : {}),
        ...(typeof context.durationMs === 'number'    ? { duration_ms:    context.durationMs }    : {}),
        ...(context.actor ? { actor: context.actor } : {}),
        ...(context.extra ?? {}),
      },
    })
  } catch (e: any) {
    // Audit-log failures are non-fatal (the source-of-truth is the row
    // itself). Surface in console so monitoring picks it up.
    console.warn('[integrations/state] audit-log write failed:', e?.message)
  }

  return { ok: true, prev_status: prevStatus, new_status: newStatus ?? prevStatus ?? 'unknown' }
}

/**
 * Convenience: fetch the last N transitions for an integration.
 * Used by admin tooling. Service-role only — RLS on the table denies
 * customer access.
 */
export async function getIntegrationHistory(
  db: Db,
  integrationId: string,
  limit: number = 50,
): Promise<any[]> {
  const { data, error } = await db
    .from('integration_state_log')
    .select('*')
    .eq('integration_id', integrationId)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('[integrations/state] history read failed:', error.message)
    return []
  }
  return data ?? []
}
