// lib/integrations/retire.ts
//
// Clean retirement of a provider. When a feature gets killed (Inzii
// 2026-04-20 was the canonical example), every existing integration row
// for that provider needs to leave the active sync queue without losing
// the historical record.
//
// Pre-this-module the convention was "leave them in 'error' state and
// hope nobody notices" — which is exactly how 5 dead Inzii rows on Vero
// kept generating "synced with 6 errors" toasts every day for a week.
//
// The right cleanup is:
//   1. Flip every row of the retired provider to status='retired' via the
//      state module (so the audit log captures it).
//   2. eligibility.ts treats 'retired' as ineligible (no probe, no email).
//   3. Rows stay in the DB so historical sync_log + tracker_data joins
//      still resolve. They just never sync again.
//
// Usage from a feature-kill PR:
//   import { retireProvider } from '@/lib/integrations/retire'
//   await retireProvider(db, 'inzii', { reason: 'Direct Swess API has no docs', actor: 'system' })

import { setIntegrationState } from './state'

export interface RetireOptions {
  reason?: string                 // free-form note, lands in audit context
  actor?:  string                 // 'admin' | 'system' | user_id
  /** When true, also run a one-shot retirement check the next time the
   *  health-check cron fires — emails the owner that an integration was
   *  retired. Off by default (this is a one-time cleanup, not a per-row
   *  notification stream). */
  notifyOwners?: boolean
}

export async function retireProvider(
  db: any,
  provider: string,
  opts: RetireOptions = {},
): Promise<{ retired_count: number; errors: number }> {
  const { data: rows, error } = await db
    .from('integrations')
    .select('id')
    .eq('provider', provider)
    .neq('status', 'retired')

  if (error) {
    console.error('[integrations/retire] list failed:', error.message)
    return { retired_count: 0, errors: 1 }
  }

  let retired = 0
  let errors  = 0
  for (const row of (rows ?? [])) {
    const r = await setIntegrationState(db, row.id, 'retired', {
      actor: opts.actor ?? 'system',
      extra: {
        provider,
        reason: opts.reason ?? 'no reason given',
        notify_owners: opts.notifyOwners ?? false,
      },
    })
    if (r.ok) retired++
    else      errors++
  }

  return { retired_count: retired, errors }
}
