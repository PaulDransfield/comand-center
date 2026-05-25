// app/api/cron/scheduling-sync/route.ts
//
// Nightly cron that pulls schedules from Personalkollen into M100 tables.
// Runs at 05:30 UTC (after master-sync at 04:00 + before anomaly-check).
//
// Per business with a connected PK integration:
//   1. Resolve the API token from credentials_enc
//   2. Call syncScheduleFromPK to populate staff_shift_templates +
//      staff_shifts for the current 12-week back + 2-week forward window
//   3. Log telemetry
//
// Idempotent — re-runs just upsert the same rows.

import { NextRequest, NextResponse }   from 'next/server'
import { createAdminClient }           from '@/lib/supabase/server'
import { checkCronSecret }             from '@/lib/admin/check-secret'
import { log }                         from '@/lib/log/structured'
import { decrypt }                     from '@/lib/integrations/encryption'
import { syncScheduleFromPK }          from '@/lib/scheduling/pk-sync'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 300

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { withCronLog } = await import('@/lib/cron/log')
  return withCronLog('scheduling-sync', async () => {

  const db = createAdminClient()
  const started = Date.now()

  const { data: integrations } = await db
    .from('integrations')
    .select('id, business_id, credentials_enc, businesses(name)')
    .eq('provider', 'personalkollen')
    .in('status', ['connected', 'warning'])
  if (!integrations?.length) {
    return NextResponse.json({ ok: true, businesses_synced: 0, message: 'no active PK integrations' })
  }

  let synced = 0
  const errors: string[] = []
  let totalShifts    = 0
  let totalTemplates = 0

  for (const integ of integrations) {
    const bizName = ((integ.businesses as any)?.name) ?? '(unnamed)'
    if (!integ.business_id) continue
    try {
      // Extract token (PK creds are either bare token string or JSON envelope)
      const decoded = decrypt(integ.credentials_enc) ?? ''
      let token: string | undefined
      try {
        const o: any = JSON.parse(decoded)
        token = o.access_token ?? o.api_key ?? o.token
        if (typeof o === 'string') token = o
      } catch {
        token = decoded
      }
      if (!token || typeof token !== 'string') {
        errors.push(`${bizName}: bad credentials shape`)
        continue
      }

      const result = await syncScheduleFromPK(db, integ.business_id, token)
      totalShifts    += result.shifts_upserted
      totalTemplates += result.templates_upserted
      synced++
      log.info('scheduling-sync biz ok', {
        route:           'cron/scheduling-sync',
        business_id:     integ.business_id,
        shifts_upserted: result.shifts_upserted,
        templates_total: result.templates_total,
        pages_fetched:   result.pages_fetched,
        errors:          result.errors,
      })
    } catch (e: any) {
      errors.push(`${bizName}: ${e?.message ?? String(e)}`)
      log.error('scheduling-sync biz failed', {
        route:        'cron/scheduling-sync',
        business_id:  integ.business_id,
        error:        e?.message ?? String(e),
      })
    }
  }

  log.info('scheduling-sync complete', {
    route:               'cron/scheduling-sync',
    duration_ms:         Date.now() - started,
    businesses_synced:   synced,
    businesses_failed:   errors.length,
    total_shifts:        totalShifts,
    total_templates:     totalTemplates,
  })

  return NextResponse.json({
    ok:                synced > 0 || errors.length === 0,
    businesses_synced: synced,
    total_shifts:      totalShifts,
    total_templates:   totalTemplates,
    errors:            errors.length > 0 ? errors.slice(0, 10) : undefined,
    timestamp:         new Date().toISOString(),
  })
  })
}

export const GET = POST
